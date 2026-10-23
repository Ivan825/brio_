// Plan editor API (BUILD_PLAN M3): versions, edits (each a new version with lint), approve, and replan with notes.
import { PlanEdit, PlanEditError } from "@brio/core";
import { schema } from "@brio/db";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { HttpError, requireMember, requireSession } from "../http";
import { cancelMission } from "../missions";
import { approvePlan, editPlan } from "../orchestrator/plans";

const { missions, plans } = schema;
const Params = z.object({ id: z.uuid() });
const VersionParams = z.object({ id: z.uuid(), version: z.coerce.number().int().positive() });
const Edits = z.object({ edits: z.array(PlanEdit).min(1).max(50) });
const Replan = z.object({ notes: z.array(z.string().trim().min(1).max(4000)).max(10).default([]) });

export async function planRoutes(app: FastifyInstance, ctx: AppContext) {
  const missionFor = async (
    req: Parameters<typeof requireSession>[1],
    roles?: ("owner" | "admin" | "member")[],
  ) => {
    const s = await requireSession(ctx, req);
    const { id } = Params.parse(req.params);
    const [m] = await ctx.db.select().from(missions).where(eq(missions.id, id));
    if (!m) throw new HttpError(404, "mission not found", "not_found");
    await requireMember(ctx, m.workspaceId, s, roles);
    return { s, m };
  };

  app.get("/v1/missions/:id/plans", async (req) => {
    const { m } = await missionFor(req);
    const rows = await ctx.db
      .select()
      .from(plans)
      .where(eq(plans.missionId, m.id))
      .orderBy(asc(plans.version));
    return {
      plans: rows.map((p) => ({
        version: p.version,
        status: p.status,
        origin: p.origin,
        graph: p.graph,
        lint: p.lint,
        approvedBy: p.approvedBy,
        createdAt: p.createdAt,
      })),
    };
  });

  /** Applies edits to the latest proposed version and stores the result as the next version. */
  app.post("/v1/missions/:id/plans/:version/edits", async (req, reply) => {
    const { s, m } = await missionFor(req, ["owner", "admin", "member"]);
    const { version } = VersionParams.parse(req.params);
    const { edits } = Edits.parse(req.body);
    try {
      const { plan, lint } = await editPlan(ctx, m, version, edits, `user:${s.userId}`);
      return reply.status(201).send({
        plan: {
          version: plan.version,
          status: plan.status,
          graph: plan.graph,
          lint: { errors: lint.errors, warnings: lint.warnings, fixes: lint.fixes, estimate: lint.estimate },
        },
      });
    } catch (e) {
      if (e instanceof PlanEditError) throw new HttpError(422, e.message, "invalid_edit");
      throw e;
    }
  });

  app.post("/v1/missions/:id/plans/:version/approve", async (req) => {
    const { s, m } = await missionFor(req, ["owner", "admin", "member"]);
    const { version } = VersionParams.parse(req.params);
    await approvePlan(ctx, m, version, `user:${s.userId}`, s.userId);
    ctx.orchestrator.schedule(m.id);
    return { approved: version };
  });

  /** Rejects the proposal and plans again with the user's notes (answers to the planner's questions, changes). */
  app.post("/v1/missions/:id/replan", async (req) => {
    const { s, m } = await missionFor(req, ["owner", "admin", "member"]);
    if (!["awaiting_approval", "draft", "failed"].includes(m.status))
      throw new HttpError(409, `a ${m.status} mission cannot be replanned`, "not_replannable");
    const { notes } = Replan.parse(req.body ?? {});
    await ctx.orchestrator.replan(m, notes, `user:${s.userId}`);
    return { replanning: true };
  });

  app.post("/v1/missions/:id/cancel", async (req) => {
    const { s, m } = await missionFor(req, ["owner", "admin", "member"]);
    await cancelMission(ctx, m, `user:${s.userId}`);
    return { cancelled: true };
  });
}
