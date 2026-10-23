import {
  adapterFor,
  fetchAgentCard,
  IMPLEMENTED_FAMILIES,
  type ModelInfo,
  pinoSink,
  redactingLogger,
  registerManusWebhook,
  ServiceClient,
  serviceBase,
  taskTypesFromSkills,
} from "@brio/adapters";
import { schema } from "@brio/db";
import { ApiStyle, type ConnectorEntry, registry } from "@brio/registry";
import { ConnectorRoute, TaskType } from "@brio/schema";
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
import { manusHookUrl } from "./hooks";

const { agents, connectors, connectorModels } = schema;

const ApiKey = z.string().trim().min(8, "that does not look like an API key").max(4096);
const CreateConnector = z.object({
  registryKey: z.string().min(1),
  preset: z.string().min(1).optional(),
  /** For service connectors: which of the entry's services, and its install settings (non-secret). */
  service: z.string().min(1).optional(),
  settings: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]*$/), z.string().trim().min(1).max(2000)).optional(),
  displayName: z.string().trim().min(1).max(80).optional(),
  apiKey: ApiKey.optional(),
  baseUrl: z.url().optional(),
  region: z.string().min(1).optional(),
  apiStyle: ApiStyle.optional(),
  /** The task types its agents take (A2A agents: defaults to what its skills suggest). */
  taskTypes: z.array(TaskType).min(1).max(TaskType.options.length).optional(),
  /** A coding CLI under the person's own sign-in, for agents on a local runner (no key). */
  localLogin: z.literal(true).optional(),
  /** For vendors whose terms allow sign-in use only for the person's own work: they say it is. */
  ownUse: z.literal(true).optional(),
});
const UpdateConnector = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  apiKey: ApiKey.optional(),
  status: z.enum(["active", "disabled"]).optional(),
  taskTypes: z.array(TaskType).min(1).max(TaskType.options.length).optional(),
});
const Params = z.object({ id: z.uuid() });

const secretLabel = (connectorId: string) => `connector:${connectorId}`;

function present(row: ConnectorRow) {
  const cfg = row.config as unknown as StoredConnectorConfig;
  const preset = cfg.preset ? registry().preset(cfg.preset) : undefined;
  const service = cfg.service ? registry().service(cfg.service) : undefined;
  const entry = registry().connector(row.registryKey);
  return {
    id: row.id,
    registryKey: row.registryKey,
    name: entry?.name ?? row.registryKey,
    displayName: row.displayName,
    route: row.route,
    preset: cfg.preset ?? null,
    presetName: preset?.name ?? service?.name ?? cfg.preset ?? null,
    service: cfg.service ?? null,
    serviceKind: service?.kind ?? null,
    settings: cfg.settings ?? {},
    adapter: cfg.adapter ?? service?.adapter ?? preset?.family ?? null,
    taskTypes: cfg.taskTypes ?? null,
    agentCard: cfg.agentCard ?? null,
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
    // A CLI under the person's own sign-in is checked where it runs (the local runner), never with a key from here.
    if ((row.config as { localLogin?: unknown }).localLogin) {
      const [updated] = await ctx.db
        .update(connectors)
        .set({
          health: {
            ok: true,
            checkedAt: new Date().toISOString(),
            latencyMs: 0,
            detail: "runs under your own sign-in on a local runner",
          },
          ...(row.status === "disabled" ? {} : { status: "active" }),
        })
        .where(eq(connectors.id, row.id))
        .returning();
      return updated ?? row;
    }
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
    await requireMember(ctx, workspaceId, s);
    const rows = await ctx.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.workspaceId, workspaceId), isNull(connectors.deletedAt)))
      .orderBy(asc(connectors.createdAt));
    return { connectors: rows.map(present) };
  });

  type InstallPlan = {
    config: StoredConnectorConfig;
    adapter: NonNullable<ReturnType<typeof adapterFor>>;
    /** The preset or service key, for the ledger. */
    label: string;
    name: string;
    baseUrl: string;
    /** The entry offers several presets or services (the display name says which). */
    multiple: boolean;
  };

  /** A model-API or CLI connector: one of the entry's presets, with its region, base URL and API style. */
  const presetInstall = async (
    entry: ConnectorEntry,
    body: z.infer<typeof CreateConnector>,
  ): Promise<InstallPlan> => {
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
    // A CLI under the person's own sign-in has no key (checked below against the vendor's terms).
    if (needsKey && !body.apiKey && !(cliAdapter && body.localLogin))
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
    return { config, adapter, label: presetKey, name: preset.name, baseUrl, multiple: presets.length > 1 };
  };

  /**
   * A service connector (hosted agents, media, search, browsers): one of the entry's services, with its install
   * settings checked against the registry's patterns and its base URL filled from them.
   */
  const serviceInstall = async (
    entry: ConnectorEntry,
    body: z.infer<typeof CreateConnector>,
  ): Promise<InstallPlan> => {
    const services = registry().servicesFor(entry.id);
    const chosen = body.service ? services.find((x) => x.key === body.service) : services[0];
    if (!chosen)
      throw new HttpError(422, `${body.service} is not a service of ${entry.name}`, "unknown_service");
    const sv = chosen.service;
    const settings = body.settings ?? {};
    for (const key of Object.keys(settings))
      if (!sv.settings.some((x) => x.key === key))
        throw new HttpError(422, `${sv.name} has no setting ${key}`, "unknown_setting");
    for (const st of sv.settings) {
      const v = settings[st.key];
      if (!v && st.required) throw new HttpError(422, `${sv.name} needs ${st.label}`, "setting_required");
      if (v && st.pattern && !new RegExp(st.pattern).test(v))
        throw new HttpError(
          422,
          `${st.label} does not look right${st.placeholder ? ` (like ${st.placeholder})` : ""}`,
          "bad_setting",
        );
    }
    if (!body.apiKey && sv.auth.scheme !== "optional-bearer")
      throw new HttpError(422, `${sv.name} needs an API key`, "api_key_required");
    let baseUrl: string;
    try {
      baseUrl = serviceBase({
        registryKey: entry.id,
        serviceKey: chosen.key,
        service: sv,
        settings,
        baseUrl: "",
      });
    } catch (e) {
      throw new HttpError(422, (e as Error).message, "bad_setting");
    }
    await ctx.checkUrl(baseUrl).catch((e: Error) => {
      throw new HttpError(422, e.message, "unsafe_url");
    });
    const adapter = adapterFor(sv.adapter);
    if (!adapter) throw new HttpError(422, `no adapter for ${sv.name}`, "no_adapter");
    return {
      config: { service: chosen.key, settings, baseUrl },
      adapter,
      label: chosen.key,
      name: sv.name,
      baseUrl,
      multiple: services.length > 1,
    };
  };

  /** Installs a connector: the key goes to the vault, the dispatchable config to the row, then a health check runs. */
  app.post("/v1/connectors", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s, ["owner", "admin"]);
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
    const plan =
      r.servicesFor(entry.id).length && (body.service || !installablePresets(entry).length)
        ? await serviceInstall(entry, body)
        : await presetInstall(entry, body);
    const { config, adapter, label: presetKey, baseUrl, multiple } = plan;
    if (body.localLogin) {
      // Only where the vendor's terms allow it (SECURITY_GOVERNANCE §1), and never with a key.
      if (adapter.route !== "cli" || !entry.localLogin)
        throw new HttpError(
          422,
          `${entry.name} cannot run under your own sign-in: its terms are not verified for that; add an API key instead`,
          "local_login_not_allowed",
        );
      if (body.apiKey)
        throw new HttpError(422, "a sign-in connector takes no API key", "local_login_with_key");
      if (entry.localLogin === "own-use" && !body.ownUse)
        throw new HttpError(
          422,
          `${entry.name}'s terms allow your own sign-in only for your own work: confirm that it is (ownUse)`,
          "own_use_required",
        );
      (config as StoredConnectorConfig).localLogin = {
        by: s.userId,
        at: new Date().toISOString(),
        terms: entry.localLogin,
      };
    }
    const row = await ctx.db.transaction(async (tx) => {
      const created = one(
        await tx
          .insert(connectors)
          .values({
            workspaceId,
            registryKey: entry.id,
            displayName: body.displayName ?? (multiple ? plan.name : entry.name),
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
    let checked = await check(row);
    // An A2A agent: read its card for what it says it does; its skills suggest the task types it takes.
    if ((config as StoredConnectorConfig).service === "a2a") {
      const card = await fetchAgentCard(
        new ServiceClient(connectorConfig(checked), {
          credential: await credentialOf(ctx, checked),
          fetch: ctx.fetch,
        }),
      ).catch(() => null);
      const skills = (card?.skills ?? []).map((k) => ({
        id: k.id,
        name: k.name,
        description: k.description.slice(0, 500),
        tags: k.tags,
      }));
      checked = one(
        await ctx.db
          .update(connectors)
          .set({
            ...(card ? { displayName: body.displayName ?? card.name.slice(0, 80) } : {}),
            config: {
              ...(checked.config as Record<string, unknown>),
              taskTypes: body.taskTypes ?? (card ? taskTypesFromSkills(skills) : ["write.summary"]),
              ...(card
                ? {
                    agentCard: {
                      name: card.name,
                      description: card.description.slice(0, 1000),
                      skills: skills.map(({ tags: _t, ...k }) => k),
                    },
                  }
                : {}),
            },
          })
          .where(eq(connectors.id, checked.id))
          .returning(),
        "connector",
      );
    }
    // Manus reports stopped tasks by webhook when Brio has a public address to send them to (the board learns at
    // once; runs still poll). Registration failing leaves polling alone, and says why.
    if ((config as StoredConnectorConfig).service === "manus" && ctx.config.APP_URL.startsWith("https://")) {
      const url = manusHookUrl(ctx.config.APP_URL, checked.id);
      const webhook = await registerManusWebhook(
        new ServiceClient(connectorConfig(checked), {
          credential: await credentialOf(ctx, checked),
          fetch: ctx.fetch,
        }),
        url,
      ).then(
        (id) => ({ url, id }),
        (e: Error) => ({ url, error: ctx.redactor.redact(e.message).slice(0, 300) }),
      );
      checked = one(
        await ctx.db
          .update(connectors)
          .set({ config: { ...(checked.config as Record<string, unknown>), webhook } })
          .where(eq(connectors.id, checked.id))
          .returning(),
        "connector",
      );
    }
    return reply.status(201).send({ connector: present(checked) });
  });

  app.patch("/v1/connectors/:id", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s, ["owner", "admin"]);
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
            ...(body.taskTypes
              ? { config: { ...(row.config as Record<string, unknown>), taskTypes: body.taskTypes } }
              : {}),
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
    await requireMember(ctx, workspaceId, s, ["owner", "admin"]);
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
    await requireMember(ctx, workspaceId, s, ["owner", "admin", "member"]);
    const row = await load(workspaceId, Params.parse(req.params).id);
    return { connector: present(await check(row)) };
  });

  /** The connector's models: cached, or live with ?refresh=true (and on first use). Prices attached where known. */
  app.get("/v1/connectors/:id/models", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s);
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
      // Services without a list endpoint offer the ids their docs name (registry data, D-62).
      if (!live.length && cfg.service) live = cfg.service.models.static.map((id) => ({ id }));
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
          cfg.presetKey ?? cfg.service?.pricing.pricePreset ?? "",
          live,
          "models_endpoint",
          `${cfg.baseUrl}${cfg.preset?.models.path ?? cfg.service?.models.path ?? ""}`,
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
      cfg.presetKey ?? cfg.service?.pricing.pricePreset ?? "",
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
