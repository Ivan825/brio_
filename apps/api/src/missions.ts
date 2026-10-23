// Starting a mission: the one way in, for the web app, the REST API, Brio's MCP server and its A2A server alike.
import { schema } from "@brio/db";
import { type Actor, MissionPriority, MissionRouting, PlanGraph } from "@brio/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "./context";
import { HttpError, one, requireMember, type SessionInfo } from "./http";
import { storePlan } from "./orchestrator/plans";

const { missions } = schema;

export const CreateMission = z.object({
  goal: z.string().trim().min(1).max(10_000),
  title: z.string().trim().min(1).max(200).optional(),
  projectId: z.uuid().optional(),
  priority: MissionPriority.default("balanced"),
  budget: z
    .object({ usd: z.number().positive().optional(), minutes: z.number().positive().optional() })
    .optional(),
  /** The agent that plans; omitted, the static router picks a model-API agent. */
  plannerAgentId: z.uuid().optional(),
  /** Start without waiting for approval when the plan is clean and small (≤ $5, ≤ 10 tasks). */
  autoApprove: z.boolean().default(false),
  /** learned (default), static, or one agent alone (the eval baseline). */
  routing: MissionRouting.default({ strategy: "learned" }),
  /**
   * A plan made elsewhere (another planner, a handoff, the eval harness): it becomes plan v1 for approval and no
   * planner runs.
   */
  plan: PlanGraph.optional(),
});
export type CreateMissionInput = z.input<typeof CreateMission>;

export const titleFrom = (goal: string) => (goal.length <= 80 ? goal : `${goal.slice(0, 77).trimEnd()}…`);

/** Creates a mission for a member who may act, then plans it (or proposes the supplied plan for approval). */
export async function createMission(
  ctx: AppContext,
  s: SessionInfo,
  workspaceId: string,
  input: CreateMissionInput,
  actor: Actor = `user:${s.userId}`,
) {
  await requireMember(ctx, workspaceId, s, ["owner", "admin", "member"]);
  const body = CreateMission.parse(input);
  if (body.projectId) {
    const [p] = await ctx.db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(and(eq(schema.projects.id, body.projectId), eq(schema.projects.workspaceId, workspaceId)));
    if (!p) throw new HttpError(404, "project not found", "not_found");
  }
  if (body.routing.strategy === "single") {
    const [agent] = await ctx.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.id, body.routing.agentId), eq(schema.agents.workspaceId, workspaceId)));
    if (!agent) throw new HttpError(422, "the single agent is not in this workspace", "unknown_agent");
  }
  const mission = await ctx.db.transaction(async (tx) => {
    const m = one(
      await tx
        .insert(missions)
        .values({
          workspaceId,
          projectId: body.projectId ?? null,
          title: body.title ?? titleFrom(body.goal),
          goal: body.goal,
          priority: body.priority,
          budget: body.budget ?? {},
          plannerAgentId: body.plannerAgentId ?? null,
          autoApprove: body.autoApprove,
          routing: body.routing,
          status: body.plan ? "awaiting_approval" : "planning",
          createdBy: s.userId,
        })
        .returning(),
      "mission",
    );
    await ctx.events.append(tx, {
      workspaceId,
      missionId: m.id,
      type: "mission.created",
      actor,
      payload: { title: m.title, goal: m.goal, priority: m.priority, budget: m.budget, routing: m.routing },
    });
    if (body.plan) await storePlan(ctx, tx, m, body.plan, "supplied", actor);
    return m;
  });
  if (!body.plan) await ctx.orchestrator.startMission(mission);
  return mission;
}
