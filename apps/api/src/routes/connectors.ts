import { adapterFor, IMPLEMENTED_FAMILIES, type ModelInfo, pinoSink, redactingLogger } from "@brio/adapters";
import { schema } from "@brio/db";
import { ApiStyle, registry } from "@brio/registry";
import { ConnectorRoute } from "@brio/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  adapterOf,
  type ConnectorRow,
  connectorConfig,
  credentialOf,
  installablePresets,
  type StoredConnectorConfig,
} from "../connectors";
import type { AppContext } from "../context";
import { HttpError, one, requireMember, requireSession, workspaceFor } from "../http";
import { pricesFromModels } from "../pricing";

const { agents, connectors, connectorModels } = schema;

const ApiKey = z.string().trim().min(8, "that does not look like an API key").max(4096);
const CreateConnector = z.object({
  registryKey: z.string().min(1),
  preset: z.string().min(1).optional(),
  displayName: z.string().trim().min(1).max(80).optional(),
  apiKey: ApiKey.optional(),
  baseUrl: z.url().optional(),
  region: z.string().min(1).optional(),
  apiStyle: ApiStyle.optional(),
});
const UpdateConnector = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  apiKey: ApiKey.optional(),
  status: z.enum(["active", "disabled"]).optional(),
});
const Params = z.object({ id: z.uuid() });

const secretLabel = (connectorId: string) => `connector:${connectorId}`;

function present(row: ConnectorRow) {
  const cfg = row.config as unknown as StoredConnectorConfig;
  const preset = registry().preset(cfg.preset);
  const entry = registry().connector(row.registryKey);
  return {
    id: row.id,
    registryKey: row.registryKey,
    name: entry?.name ?? row.registryKey,
    displayName: row.displayName,
    route: row.route,
    preset: cfg.preset,
    presetName: preset?.name ?? cfg.preset,
    adapter: cfg.adapter ?? preset?.family ?? null,
    baseUrl: cfg.baseUrl,
    region: cfg.region ?? null,
    apiStyle: cfg.apiStyle ?? preset?.apiStyles[0] ?? null,
    hasKey: row.credentialRef !== null,
    health: row.health,
    status: row.status,
    regionLimited: preset?.regionLimited ?? entry?.regionLimited ?? null,
    local: preset?.local ?? false,
    createdAt: row.createdAt,
  };
}

export async function connectorRoutes(app: FastifyInstance, ctx: AppContext) {
  const load = async (workspaceId: string, id: string) => {
    const [row] = await ctx.db
      .select()
      .from(connectors)
      .where(
        and(eq(connectors.id, id), eq(connectors.workspaceId, workspaceId), isNull(connectors.deletedAt)),
      );
    if (!row) throw new HttpError(404, "connector not found", "not_found");
    return row;
  };

  const check = async (row: ConnectorRow) => {
    const adapter = adapterOf(row);
    const health = await adapter.healthCheck(connectorConfig(row), {
      credential: await credentialOf(ctx, row),
      logger: redactingLogger(pinoSink(ctx.log), ctx.redactor, { connectorId: row.id }),
      fetch: ctx.fetch,
    });
    const stored = health.ok
      ? {
          ok: true,
          checkedAt: new Date().toISOString(),
          latencyMs: health.latencyMs,
          detail: health.detail ?? null,
        }
      : {
          ok: false,
          checkedAt: new Date().toISOString(),
          latencyMs: health.latencyMs,
          error: health.error,
          code: health.code,
        };
    const [updated] = await ctx.db
      .update(connectors)
      .set({
        health: stored,
        ...(row.status === "disabled" ? {} : { status: health.ok ? "active" : "error" }),
      })
      .where(eq(connectors.id, row.id))
      .returning();
    return updated ?? row;
  };

  app.get("/v1/connectors", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s.userId);
    const rows = await ctx.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.workspaceId, workspaceId), isNull(connectors.deletedAt)))
      .orderBy(asc(connectors.createdAt));
    return { connectors: rows.map(present) };
  });

  /** Installs a connector: the key goes to the vault, the dispatchable config to the row, then a health check runs. */
  app.post("/v1/connectors", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s.userId, ["owner", "admin"]);
    const body = CreateConnector.parse(req.body);
    const r = registry();
    const entry = r.connector(body.registryKey);
    if (!entry) throw new HttpError(404, "no such connector in the registry", "not_found");
    if (!entry.supported)
      throw new HttpError(422, `${entry.name} has no official route Brio can use`, "unsupported");
    if (!r.isImplemented(entry.id, IMPLEMENTED_FAMILIES))
      throw new HttpError(
        422,
        `${entry.name} arrives in ${entry.buildMilestone ?? "a later milestone"}`,
        "not_implemented",
      );
    const presets = installablePresets(entry);
    const chosen = body.preset ? presets.find((p) => p.key === body.preset) : presets[0];
    if (!chosen)
      throw new HttpError(422, `${body.preset} is not a preset of ${entry.name}`, "unknown_preset");
    const { key: presetKey, preset } = chosen;
    const cliAdapter = "adapter" in chosen ? chosen.adapter : undefined;

    let baseUrl = preset.baseUrl;
    if (body.region) {
      baseUrl = preset.regions[body.region] ?? null;
      if (!baseUrl) throw new HttpError(422, `${preset.name} has no region ${body.region}`, "unknown_region");
    }
    if (body.baseUrl) {
      if (!preset.baseUrlEditable)
        throw new HttpError(422, `${preset.name}'s base URL is fixed`, "fixed_base_url");
      baseUrl = body.baseUrl.replace(/\/+$/, "");
    }
    if (!baseUrl)
      throw new HttpError(422, `${preset.name} needs the base URL of your server`, "base_url_required");
    await ctx.checkUrl(baseUrl).catch((e: Error) => {
      throw new HttpError(422, e.message, "unsafe_url");
    });
    const needsKey = preset.auth !== "none" && preset.auth !== "optional-bearer";
    if (needsKey && !body.apiKey)
      throw new HttpError(422, `${preset.name} needs an API key`, "api_key_required");
    if (body.apiStyle && (cliAdapter || !preset.apiStyles.includes(body.apiStyle)))
      throw new HttpError(
        422,
        `${preset.name} does not support the ${body.apiStyle} API`,
        "unsupported_api_style",
      );
    const adapter = adapterFor(cliAdapter ?? preset.family);
    if (!adapter) throw new HttpError(422, `no adapter for ${preset.family}`, "no_adapter");

    const config: StoredConnectorConfig = {
      ...(cliAdapter ? { adapter: cliAdapter } : {}),
      preset: presetKey,
      baseUrl,
      ...(body.region ? { region: body.region } : {}),
      ...(body.apiStyle ? { apiStyle: body.apiStyle } : {}),
    };
    const row = await ctx.db.transaction(async (tx) => {
      const created = one(
        await tx
          .insert(connectors)
          .values({
            workspaceId,
            registryKey: entry.id,
            displayName: body.displayName ?? (presets.length > 1 ? preset.name : entry.name),
            route: ConnectorRoute.parse(adapter.route),
            config: config as unknown as Record<string, unknown>,
          })
          .returning(),
        "connector",
      );
      let credentialRef: string | null = null;
      if (body.apiKey) {
        const secret = await ctx.vault.put(tx, {
          workspaceId,
          label: secretLabel(created.id),
          value: body.apiKey,
          createdBy: s.userId,
        });
        credentialRef = secret.id;
        await ctx.ledger.append(tx, {
          workspaceId,
          kind: "key.added",
          payload: { secretId: secret.id, label: secret.label, connectorId: created.id, by: s.userId },
        });
      }
      await ctx.ledger.append(tx, {
        workspaceId,
        kind: "connector.added",
        payload: { connectorId: created.id, registryKey: entry.id, preset: presetKey, baseUrl, by: s.userId },
      });
      return one(
        await tx.update(connectors).set({ credentialRef }).where(eq(connectors.id, created.id)).returning(),
        "connector",
      );
    });
    const checked = await check(row);
    return reply.status(201).send({ connector: present(checked) });
  });

  app.patch("/v1/connectors/:id", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s.userId, ["owner", "admin"]);
    const row = await load(workspaceId, Params.parse(req.params).id);
    const body = UpdateConnector.parse(req.body);
    const updated = await ctx.db.transaction(async (tx) => {
      let credentialRef = row.credentialRef;
      if (body.apiKey) {
        if (row.credentialRef) await ctx.vault.remove(tx, workspaceId, row.credentialRef);
        const secret = await ctx.vault.put(tx, {
          workspaceId,
          label: secretLabel(row.id),
          value: body.apiKey,
          createdBy: s.userId,
        });
        credentialRef = secret.id;
        await ctx.ledger.append(tx, {
          workspaceId,
          kind: row.credentialRef ? "key.rotated" : "key.added",
          payload: { secretId: secret.id, label: secret.label, connectorId: row.id, by: s.userId },
        });
      }
      return one(
        await tx
          .update(connectors)
          .set({
            credentialRef,
            ...(body.displayName ? { displayName: body.displayName } : {}),
            ...(body.status ? { status: body.status } : {}),
          })
          .where(eq(connectors.id, row.id))
          .returning(),
        "connector",
      );
    });
    return { connector: present(body.apiKey ? await check(updated) : updated) };
  });

  /** Soft-deletes the connector and its agents, and destroys the stored key. */
  app.delete("/v1/connectors/:id", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s.userId, ["owner", "admin"]);
    const row = await load(workspaceId, Params.parse(req.params).id);
    await ctx.db.transaction(async (tx) => {
      const now = new Date();
      await tx
        .update(connectors)
        .set({ deletedAt: now, credentialRef: null })
        .where(eq(connectors.id, row.id));
      await tx
        .update(agents)
        .set({ deletedAt: now })
        .where(and(eq(agents.connectorId, row.id), isNull(agents.deletedAt)));
      if (row.credentialRef) {
        await ctx.vault.remove(tx, workspaceId, row.credentialRef);
        await ctx.ledger.append(tx, {
          workspaceId,
          kind: "key.removed",
          payload: { secretId: row.credentialRef, connectorId: row.id, by: s.userId },
        });
      }
      await ctx.ledger.append(tx, {
        workspaceId,
        kind: "connector.removed",
        payload: { connectorId: row.id, registryKey: row.registryKey, by: s.userId },
      });
    });
    return reply.status(204).send();
  });

  app.post("/v1/connectors/:id/health", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s.userId, ["owner", "admin", "member"]);
    const row = await load(workspaceId, Params.parse(req.params).id);
    return { connector: present(await check(row)) };
  });

  /** The connector's models: cached, or live with ?refresh=true (and on first use). Prices attached where known. */
  app.get("/v1/connectors/:id/models", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s.userId);
    const row = await load(workspaceId, Params.parse(req.params).id);
    const refresh = (req.query as { refresh?: string }).refresh === "true";
    let cached = await ctx.db
      .select()
      .from(connectorModels)
      .where(eq(connectorModels.connectorId, row.id))
      .orderBy(asc(connectorModels.model));

    let listedLive = false;
    if (refresh || cached.length === 0) {
      const cfg = connectorConfig(row);
      const adapter = adapterOf(row);
      let live: ModelInfo[];
      try {
        live =
          (await adapter.listModels?.(cfg, { credential: await credentialOf(ctx, row), fetch: ctx.fetch })) ??
          [];
      } catch (e) {
        throw new HttpError(
          502,
          `the vendor's model list failed: ${ctx.redactor.redact((e as Error).message)}`,
          "vendor_error",
        );
      }
      listedLive = true;
      await ctx.db.transaction(async (tx) => {
        await tx.delete(connectorModels).where(eq(connectorModels.connectorId, row.id));
        if (live.length)
          await tx.insert(connectorModels).values(
            live.map((m) => ({
              workspaceId,
              connectorId: row.id,
              model: m.id,
              displayName: m.displayName ?? null,
              contextTokens: m.contextTokens ?? null,
              maxOutputTokens: m.maxOutputTokens ?? null,
              meta: {
                ...(m.capabilities ? { capabilities: m.capabilities } : {}),
                ...(m.createdAt ? { createdAt: m.createdAt } : {}),
              },
            })),
          );
      });
      await ctx.pricing.upsert(
        pricesFromModels(
          cfg.presetKey,
          live,
          "models_endpoint",
          `${cfg.baseUrl}${cfg.preset.models.path ?? ""}`,
        ),
      );
      cached = await ctx.db
        .select()
        .from(connectorModels)
        .where(eq(connectorModels.connectorId, row.id))
        .orderBy(asc(connectorModels.model));
    }
    const cfg = connectorConfig(row);
    const prices = await ctx.pricing.lookupMany(
      cfg.presetKey,
      cached.map((m) => m.model),
    );
    const models = cached.map((m, i) => {
      const price = prices[i];
      return {
        id: m.model,
        displayName: m.displayName,
        contextTokens: m.contextTokens,
        maxOutputTokens: m.maxOutputTokens,
        price: !price || price.kind === "unknown" ? null : { kind: price.kind, ...price.price },
        listedAt: m.listedAt,
      };
    });
    return { models, live: listedLive };
  });
}
