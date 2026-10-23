// The scoreboard (ROUTING §5): who wins at which task type, at what cost and speed, with a trend per row; and people's
// thumbs up/down on attempts, which feed the same scores.
import { decay, passRate } from "@brio/core";
import { schema } from "@brio/db";
import { and, asc, eq, gte, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { HttpError, requireMember, requireSession, workspaceFor } from "../http";
import { routeAgents } from "../orchestrator/agents";
import { attemptAgentKey } from "../orchestrator/scoreboard";

const { attempts, ratings, scoreHistory, scores, tasks } = schema;

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

const TREND_POINTS = 30;

export async function scoreboardRoutes(app: FastifyInstance, ctx: AppContext) {
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
