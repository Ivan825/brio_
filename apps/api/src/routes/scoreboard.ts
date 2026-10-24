// The scoreboard (ROUTING §5): who wins at which task type, at what cost and speed, with a trend per row; and people's
// thumbs up/down on attempts, which feed the same scores.
import { decay, passRate } from "@brio/core";
import { schema } from "@brio/db";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { HttpError, requireMember, requireSession, workspaceFor } from "../http";
import { routeAgents } from "../orchestrator/agents";
import {
  attemptAgentKey,
  GLOBAL_MIN_CONTRIBUTORS,
  GLOBAL_MIN_N,
  scoreSharingOf,
} from "../orchestrator/scoreboard";

const { attempts, ratings, scoreContributors, scoreHistory, scores, tasks, workspaces } = schema;

const Query = z.object({
  taskType: z.string().max(80).optional(),
  vendor: z.string().max(80).optional(),
  days: z.coerce.number().int().min(1).max(365).default(90),
});
const Params = z.object({ id: z.uuid() });
const RatingBody = z.object({
  rating: z.union([z.literal(1), z.literal(-1)]),
  comment: z.string().trim().max(2000).optional(),
});

const SharingBody = z.object({ share: z.boolean(), useGlobal: z.boolean() });
const GlobalQuery = z.object({ taskType: z.string().max(80).optional() });

const TREND_POINTS = 30;

export async function scoreboardRoutes(app: FastifyInstance, ctx: AppContext) {
  /** Who wins at what: pass rate, Elo, cost and speed per agent and task type, with trends (`?taskType=&vendor=&days=`). */
  app.get("/v1/scoreboard", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s);
    const q = Query.parse(req.query);
    const rows = await ctx.db
      .select()
      .from(scores)
      .where(and(eq(scores.scope, "workspace"), eq(scores.workspaceId, workspaceId)));
    const vendorOf = (key: string) => key.slice(0, key.indexOf("/"));
    const now = new Date();
    const shown = rows.filter(
      (r) => (!q.taskType || r.taskType === q.taskType) && (!q.vendor || vendorOf(r.agentKey) === q.vendor),
    );

    // Which of the workspace's agents each key stands for (a key is a vendor or CLI, and a model).
    const named = await routeAgents(ctx, workspaceId);
    const since = new Date(now.getTime() - q.days * 86_400_000);
    const history = shown.length
      ? await ctx.db
          .select()
          .from(scoreHistory)
          .where(
            and(
              eq(scoreHistory.workspaceId, workspaceId),
              inArray(scoreHistory.agentKey, [...new Set(shown.map((r) => r.agentKey))]),
              gte(scoreHistory.at, since),
            ),
          )
          .orderBy(asc(scoreHistory.at))
      : [];

    return {
      taskTypes: [...new Set(rows.map((r) => r.taskType))].sort(),
      vendors: [...new Set(rows.map((r) => vendorOf(r.agentKey)))].sort(),
      rows: shown
        .map((r) => {
          const current = decay(
            {
              alpha: r.alpha,
              beta: r.beta,
              elo: r.elo,
              avgCost: r.avgCost,
              latencyS: r.p50LatencyS,
              n: r.n,
              updatedAt: r.updatedAt,
            },
            now,
          );
          const model = r.agentKey.slice(r.agentKey.indexOf("/") + 1);
          const vendor = vendorOf(r.agentKey);
          const trend = history
            .filter((h) => h.agentKey === r.agentKey && h.taskType === r.taskType)
            .slice(-TREND_POINTS)
            .map((h) => ({ at: h.at, passRate: h.passRate, elo: h.elo }));
          return {
            agentKey: r.agentKey,
            vendor,
            model,
            agents: named.filter((a) => a.scoreKey === r.agentKey).map((a) => a.name),
            taskType: r.taskType,
            passRate: passRate(current),
            elo: Math.round(current.elo),
            avgCostUsd: r.avgCost,
            latencyS: r.p50LatencyS,
            n: r.n,
            updatedAt: r.updatedAt,
            trend,
          };
        })
        .sort((a, b) => a.taskType.localeCompare(b.taskType) || b.passRate - a.passRate || b.elo - a.elo),
    };
  });

  /** Whether this workspace adds to, and starts from, the global scoreboard (D-14). */
  app.get("/v1/scoreboard/sharing", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s);
    return { sharing: await scoreSharingOf(ctx.db, workspaceId) };
  });

  /** Whether the workspace adds to, and starts from, the global scoreboard (D-14). */
  app.put("/v1/scoreboard/sharing", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s, ["owner", "admin"]);
    const body = SharingBody.parse(req.body);
    await ctx.db.transaction(async (tx) => {
      await tx
        .update(workspaces)
        .set({
          settings: sql`${workspaces.settings} || jsonb_build_object('scores', ${JSON.stringify(body)}::jsonb)`,
        })
        .where(eq(workspaces.id, workspaceId));
      await ctx.ledger.append(tx, {
        workspaceId,
        kind: "policy.change",
        payload: { scoreSharing: body, by: s.userId },
      });
    });
    return { sharing: body };
  });

  /**
   * The global scoreboard: anonymised outcomes from every workspace that shares them. Only rows with enough outcomes
   * from enough workspaces are shown, and nothing says which workspaces those were.
   */
  app.get("/v1/scoreboard/global", async (req) => {
    const s = await requireSession(ctx, req);
    await requireMember(ctx, workspaceFor(req, s), s);
    const q = GlobalQuery.parse(req.query);
    const contributors = sql<number>`(select count(*)::int from ${scoreContributors} c where c.agent_key = ${scores.agentKey} and c.task_type = ${scores.taskType})`;
    const rows = await ctx.db
      .select({ s: scores, contributors })
      .from(scores)
      .where(and(eq(scores.scope, "global"), q.taskType ? eq(scores.taskType, q.taskType) : undefined));
    const now = new Date();
    return {
      minimum: { outcomes: GLOBAL_MIN_N, workspaces: GLOBAL_MIN_CONTRIBUTORS },
      rows: rows
        .filter((r) => r.s.n >= GLOBAL_MIN_N && r.contributors >= GLOBAL_MIN_CONTRIBUTORS)
        .map(({ s: r }) => {
          const current = decay(
            {
              alpha: r.alpha,
              beta: r.beta,
              elo: r.elo,
              avgCost: r.avgCost,
              latencyS: r.p50LatencyS,
              n: r.n,
              updatedAt: r.updatedAt,
            },
            now,
          );
          return {
            agentKey: r.agentKey,
            vendor: r.agentKey.slice(0, r.agentKey.indexOf("/")),
            model: r.agentKey.slice(r.agentKey.indexOf("/") + 1),
            taskType: r.taskType,
            passRate: passRate(current),
            elo: Math.round(current.elo),
            avgCostUsd: r.avgCost,
            latencyS: r.p50LatencyS,
            n: r.n,
          };
        })
        .sort((a, b) => a.taskType.localeCompare(b.taskType) || b.passRate - a.passRate || b.elo - a.elo),
    };
  });

  /** A person's thumbs up or down on an attempt: +0.5 α or +1 β for its agent on the task's type (once per person). */
  app.post("/v1/attempts/:id/rating", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const { id } = Params.parse(req.params);
    const body = RatingBody.parse(req.body);
    const [row] = await ctx.db
      .select({ attempt: attempts, taskType: tasks.type })
      .from(attempts)
      .innerJoin(tasks, eq(tasks.id, attempts.taskId))
      .where(eq(attempts.id, id));
    if (!row) throw new HttpError(404, "attempt not found", "not_found");
    await requireMember(ctx, row.attempt.workspaceId, s, ["owner", "admin", "member"]);
    const agentKey = attemptAgentKey(row.attempt.dispatch);
    if (!agentKey || row.attempt.status !== "succeeded")
      throw new HttpError(409, "only a finished attempt can be rated", "not_ratable");
    const inserted = await ctx.db.transaction(async (tx) => {
      const [prior] = await tx
        .select({ id: ratings.id })
        .from(ratings)
        .where(and(eq(ratings.attemptId, id), eq(ratings.userId, s.userId)))
        .for("update");
      if (prior) return null;
      const [r] = await tx
        .insert(ratings)
        .values({
          workspaceId: row.attempt.workspaceId,
          attemptId: id,
          userId: s.userId,
          rating: body.rating,
          comment: body.comment ?? null,
        })
        .returning();
      return r;
    });
    if (!inserted) throw new HttpError(409, "you already rated this attempt", "already_rated");
    await ctx.orchestrator.scores.rating(row.attempt.workspaceId, agentKey, row.taskType, body.rating);
    return reply.status(201).send({ rating: { id: inserted.id, rating: inserted.rating, agentKey } });
  });
}
