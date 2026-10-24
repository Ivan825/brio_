// Budgets (M9, SECURITY_GOVERNANCE §5): the workspace's and each agent's monthly limits, and a mission's own, with
// what is spent now. Raising a mission's budget lets the tasks a spent budget stopped run again.
import { schema } from "@brio/db";
import { and, eq, gte, isNull, like, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { monthOf } from "../budgets";
import type { AppContext } from "../context";
import { HttpError, one, requireMember, requireSession, workspaceFor } from "../http";
import { loadMission } from "./missions";

const { agents, attempts, budgets, missions, tasks } = schema;

const SetBudget = z.object({
  scopeKind: z.enum(["workspace", "agent"]),
  /** The agent's id; the workspace's own budget needs none. */
  scopeId: z.uuid().optional(),
  /** null removes the limit. */
  limitUsd: z.number().positive().max(1_000_000).nullable(),
  softPct: z.number().int().min(1).max(99).default(80),
});
const MissionBudget = z.object({
  usd: z.number().positive().max(1_000_000).optional(),
  minutes: z.number().positive().max(100_000).optional(),
});
const Params = z.object({ id: z.uuid() });

const monthStart = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
};

export async function budgetRoutes(app: FastifyInstance, ctx: AppContext) {
  /** The workspace's and its agents' monthly budgets, with this month's spend for each agent. */
  app.get("/v1/budgets", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s);
    const rows = await ctx.db.select().from(budgets).where(eq(budgets.workspaceId, workspaceId));
    const spend = await ctx.db
      .select({ agentId: attempts.agentId, usd: sql<number>`coalesce(sum(${attempts.costUsd}), 0)::float` })
      .from(attempts)
      .where(and(eq(attempts.workspaceId, workspaceId), gte(attempts.createdAt, monthStart())))
      .groupBy(attempts.agentId);
    const total = spend.reduce((n, r) => n + Number(r.usd), 0);
    const live = await ctx.db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), isNull(agents.deletedAt)));
    const limitOf = (kind: string, id: string) => rows.find((b) => b.scopeKind === kind && b.scopeId === id);
    const ws = limitOf("workspace", workspaceId);
    return {
      month: monthOf(),
      workspace: {
        limitUsd: ws?.limitUsd === null || ws?.limitUsd === undefined ? null : Number(ws.limitUsd),
        softPct: ws?.softPct ?? 80,
        spentUsd: Math.round(total * 1e6) / 1e6,
      },
      agents: live.map((a) => {
        const b = limitOf("agent", a.id);
        return {
          agentId: a.id,
          name: a.name,
          limitUsd: b?.limitUsd === null || b?.limitUsd === undefined ? null : Number(b.limitUsd),
          softPct: b?.softPct ?? 80,
          spentUsd: Math.round(Number(spend.find((r) => r.agentId === a.id)?.usd ?? 0) * 1e6) / 1e6,
        };
      }),
    };
  });

  /** Sets the workspace's or an agent's monthly limit (USD) and warning threshold; null removes it. */
  app.put("/v1/budgets", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s, ["owner", "admin"]);
    const body = SetBudget.parse(req.body);
    const scopeId = body.scopeKind === "workspace" ? workspaceId : body.scopeId;
    if (!scopeId) throw new HttpError(422, "which agent?", "agent_required");
    if (body.scopeKind === "agent") {
      const [a] = await ctx.db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, scopeId), eq(agents.workspaceId, workspaceId)));
      if (!a) throw new HttpError(404, "agent not found", "not_found");
    }
    const row = one(
      await ctx.db
        .insert(budgets)
        .values({
          workspaceId,
          scopeKind: body.scopeKind,
          scopeId,
          limitUsd: body.limitUsd,
          softPct: body.softPct,
        })
        .onConflictDoUpdate({
          target: [budgets.scopeKind, budgets.scopeId],
          // A changed limit may warn and stop again this month.
          set: {
            limitUsd: body.limitUsd,
            softPct: body.softPct,
            warnedPeriod: null,
            stoppedPeriod: null,
          },
        })
        .returning(),
      "budget",
    );
    await ctx.ledger.append(ctx.db, {
      workspaceId,
      kind: "policy.change",
      payload: {
        budget: { scope: body.scopeKind, scopeId, limitUsd: body.limitUsd, softPct: body.softPct },
        by: s.userId,
      },
    });
    return {
      budget: {
        scopeKind: row.scopeKind,
        scopeId: row.scopeId,
        limitUsd: body.limitUsd,
        softPct: row.softPct,
      },
    };
  });

  /** A mission's budget, raised or set: tasks a spent budget stopped run again. */
  app.put("/v1/missions/:id/budget", async (req) => {
    const s = await requireSession(ctx, req);
    const m = await loadMission(ctx.db, Params.parse(req.params).id);
    await requireMember(ctx, m.workspaceId, s, ["owner", "admin", "member"]);
    const body = MissionBudget.parse(req.body);
    const [updated] = await ctx.db
      .update(missions)
      .set({ budget: { ...m.budget, ...body } })
      .where(eq(missions.id, m.id))
      .returning();
    const freed = await ctx.db
      .update(tasks)
      .set({ status: "ready", blockedReason: null })
      .where(
        and(
          eq(tasks.missionId, m.id),
          eq(tasks.status, "blocked"),
          or(like(tasks.blockedReason, "budget:%"), like(tasks.blockedReason, "dispatch: budget:%")),
        ),
      )
      .returning({ id: tasks.id, key: tasks.key });
    await ctx.ledger.append(ctx.db, {
      workspaceId: m.workspaceId,
      kind: "policy.change",
      payload: { budget: { scope: "mission", scopeId: m.id, ...body }, by: s.userId },
    });
    if (freed.length) ctx.orchestrator.schedule(m.id);
    return {
      budget: updated?.budget ?? body,
      resumed: freed.map((t) => t.key),
    };
  });
}
