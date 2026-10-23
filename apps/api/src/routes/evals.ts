// Golden-mission eval runs (BUILD_PLAN M5) for the evals dashboard: the harness saves a run (or a person uploads its
// results file), and the web app lists them with their metrics tables.
import { schema } from "@brio/db";
import { EvalRun } from "@brio/schema";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { HttpError, requireMember, requireSession, workspaceFor } from "../http";

const { evalRuns } = schema;
const Params = z.object({ id: z.uuid() });

export async function evalRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/v1/evals/runs", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s.userId);
    const rows = await ctx.db
      .select()
      .from(evalRuns)
      .where(eq(evalRuns.workspaceId, workspaceId))
      .orderBy(desc(evalRuns.createdAt))
      .limit(50);
    // The list carries summaries and verdicts; per-mission results come with one run.
    return {
      runs: rows.map((r) => ({
        id: r.id,
        mode: r.mode,
        createdAt: r.createdAt,
        startedAt: r.run.startedAt,
        finishedAt: r.run.finishedAt,
        missions: r.run.missions.length,
        summaries: r.run.summaries,
        verdict: r.run.verdict,
        notes: r.run.notes ?? null,
      })),
    };
  });

  app.get("/v1/evals/runs/:id", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s.userId);
    const { id } = Params.parse(req.params);
    const [row] = await ctx.db
      .select()
      .from(evalRuns)
      .where(and(eq(evalRuns.id, id), eq(evalRuns.workspaceId, workspaceId)));
    if (!row) throw new HttpError(404, "eval run not found", "not_found");
    return { run: { id: row.id, createdAt: row.createdAt, ...row.run } };
  });

  app.post("/v1/evals/runs", { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s.userId, ["owner", "admin", "member"]);
    const run = EvalRun.parse(req.body);
    const [row] = await ctx.db
      .insert(evalRuns)
      .values({ workspaceId, mode: run.mode, run, createdBy: s.userId })
      .returning({ id: evalRuns.id });
    return reply.status(201).send({ run: { id: row?.id } });
  });
}
