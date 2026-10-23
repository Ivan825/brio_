import { schema } from "@brio/db";
import { AgentLimits, ModelPrice, SandboxProfile } from "@brio/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { adapterOf, connectorConfig, meteringOf } from "../connectors";
import type { AppContext } from "../context";
import { HttpError, one, requireMember, requireSession, workspaceFor } from "../http";

const { agents, connectors, connectorModels, runners } = schema;

const AgentBody = z.object({
  connectorId: z.uuid(),
  name: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(200),
  rolePrompt: z.string().max(20_000).default(""),
  limits: AgentLimits.default({}),
  priceOverride: ModelPrice.nullable().default(null),
  options: z.record(z.string(), z.unknown()).default({}),
  sandboxProfile: SandboxProfile.default("standard"),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  /** MCP servers (MCP connectors of the workspace) the agent may call as tools. */
  tools: z
    .array(z.object({ connectorId: z.uuid() }))
    .max(10)
    .default([]),
  /** A local runner that runs this agent (M8): a coding CLI under its owner's own sign-in. */
  runnerId: z.uuid().nullable().default(null),
});
/** Only what is sent changes (no defaults: zod applies them inside partial(), which would reset untouched fields). */
const UpdateAgent = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  rolePrompt: z.string().max(20_000).optional(),
  limits: AgentLimits.optional(),
  priceOverride: ModelPrice.nullable().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  sandboxProfile: SandboxProfile.optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  tools: z
    .array(z.object({ connectorId: z.uuid() }))
    .max(10)
    .optional(),
  runnerId: z.uuid().nullable().optional(),
});
const Params = z.object({ id: z.uuid() });

type AgentRow = typeof agents.$inferSelect;

export async function agentRoutes(app: FastifyInstance, ctx: AppContext) {
  const connectorFor = async (workspaceId: string, id: string) => {
    const [row] = await ctx.db
      .select()
      .from(connectors)
      .where(
        and(eq(connectors.id, id), eq(connectors.workspaceId, workspaceId), isNull(connectors.deletedAt)),
      );
    if (!row) throw new HttpError(404, "connector not found", "not_found");
    return row;
  };

  /** Tools must be MCP connectors of the same workspace. */
  const checkTools = async (workspaceId: string, tools: Array<{ connectorId: string }>) => {
    for (const t of tools) {
      const c = await connectorFor(workspaceId, t.connectorId);
      if (connectorConfig(c).service?.kind !== "mcp")
        throw new HttpError(422, `${c.displayName} is not an MCP server`, "not_a_tool");
    }
  };

  /**
   * A local runner's agent is a coding CLI under the runner owner's own sign-in (a sign-in connector, no key), and only
   * the runner's owner may bind agents to it.
   */
  const checkRunner = async (
    workspaceId: string,
    userId: string,
    runnerId: string | null | undefined,
    connector: typeof connectors.$inferSelect,
  ) => {
    if (!runnerId) return;
    const [r] = await ctx.db
      .select()
      .from(runners)
      .where(and(eq(runners.id, runnerId), eq(runners.workspaceId, workspaceId), isNull(runners.revokedAt)));
    if (!r) throw new HttpError(404, "runner not found", "not_found");
    if (r.ownerId !== userId)
      throw new HttpError(403, `only ${r.name}'s owner can put agents on it`, "not_runner_owner");
    if (adapterOf(connector).route !== "cli" || !(connector.config as { localLogin?: unknown }).localLogin)
      throw new HttpError(
        422,
        "agents on a local runner are coding CLIs under your own sign-in: install the CLI's connector for sign-in use",
        "runner_needs_sign_in_cli",
      );
  };

  /** Each agent with its connector and the price a run would use (null: set one before running). */
  const present = async (a: AgentRow) => {
    const [c] = await ctx.db.select().from(connectors).where(eq(connectors.id, a.connectorId));
    const cfg = c ? connectorConfig(c) : null;
    const localLogin = Boolean((c?.config as { localLogin?: unknown } | undefined)?.localLogin);
    const metering =
      c && cfg && !localLogin
        ? await meteringOf(ctx, cfg, adapterOf(c), {
            model: a.model,
            priceOverride: a.priceOverride ?? null,
            options: (a.options ?? {}) as Record<string, unknown>,
          }).catch(() => null)
        : null;
    const [listed] = await ctx.db
      .select({ model: connectorModels.model })
      .from(connectorModels)
      .where(and(eq(connectorModels.connectorId, a.connectorId), eq(connectorModels.model, a.model)));
    return {
      id: a.id,
      name: a.name,
      model: a.model,
      rolePrompt: a.rolePrompt,
      limits: a.limits,
      priceOverride: a.priceOverride ?? null,
      options: a.options,
      sandboxProfile: a.sandboxProfile,
      tags: a.tags,
      connector: c
        ? {
            id: c.id,
            displayName: c.displayName,
            registryKey: c.registryKey,
            preset: cfg?.presetKey ?? null,
            service: cfg?.serviceKey ?? null,
            status: c.status,
          }
        : null,
      price: metering?.price ? { kind: metering.priceKind, ...metering.price } : null,
      unitPrice: metering?.unitPrice ?? null,
      runnable: Boolean(c && (metering?.runnable || localLogin)),
      runnerId: a.runnerId ?? null,
      localLogin,
      notRunnableBecause: metering && !metering.runnable ? metering.reason : null,
      modelListed: Boolean(listed),
      createdAt: a.createdAt,
    };
  };

  const load = async (workspaceId: string, id: string) => {
    const [row] = await ctx.db
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.workspaceId, workspaceId), isNull(agents.deletedAt)));
    if (!row) throw new HttpError(404, "agent not found", "not_found");
    return row;
  };

  app.get("/v1/agents", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s);
    const rows = await ctx.db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), isNull(agents.deletedAt)))
      .orderBy(asc(agents.createdAt));
    return { agents: await Promise.all(rows.map(present)) };
  });

  app.post("/v1/agents", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s, ["owner", "admin", "member"]);
    const body = AgentBody.parse(req.body);
    const connector = await connectorFor(workspaceId, body.connectorId);
    const kind = connectorConfig(connector).service?.kind;
    if (kind === "search" || kind === "fetch" || kind === "cloud-browser" || kind === "mcp")
      throw new HttpError(
        422,
        `${connector.displayName} is a ${kind === "cloud-browser" ? "cloud browser" : kind === "mcp" ? "MCP server" : kind} tool agents use, not an agent`,
        "tool_connector",
      );
    await checkTools(workspaceId, body.tools);
    await checkRunner(workspaceId, s.userId, body.runnerId, connector);
    const row = one(
      await ctx.db
        .insert(agents)
        .values({ workspaceId, ...body, limits: body.limits as Record<string, unknown> })
        .returning(),
      "agent",
    );
    return reply.status(201).send({ agent: await present(row) });
  });

  app.patch("/v1/agents/:id", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s, ["owner", "admin", "member"]);
    const row = await load(workspaceId, Params.parse(req.params).id);
    const body = UpdateAgent.parse(req.body);
    if (body.tools) await checkTools(workspaceId, body.tools);
    if (body.runnerId)
      await checkRunner(
        workspaceId,
        s.userId,
        body.runnerId,
        await connectorFor(workspaceId, row.connectorId),
      );
    const updated = one(
      await ctx.db
        .update(agents)
        .set({ ...body, ...(body.limits ? { limits: body.limits as Record<string, unknown> } : {}) })
        .where(eq(agents.id, row.id))
        .returning(),
      "agent",
    );
    return { agent: await present(updated) };
  });

  app.delete("/v1/agents/:id", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s, ["owner", "admin", "member"]);
    const row = await load(workspaceId, Params.parse(req.params).id);
    await ctx.db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, row.id));
    return reply.status(204).send();
  });
}
