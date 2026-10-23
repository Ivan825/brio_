// Starting a mission: the one way in, for the web app, the REST API, Brio's MCP server and its A2A server alike.
import { schema } from "@brio/db";
import { type Actor, MissionPriority, MissionRouting, PlanGraph } from "@brio/schema";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "./context";
import { HttpError, one, requireMember, type SessionInfo } from "./http";
import { InputFile, MAX_INPUT_FILES, readIssue, storeInputFiles } from "./mission-inputs";
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
  /** A GitHub issue or pull request the mission is about; read once, now. */
  issueUrl: z.url().max(500).optional(),
  /** Files to work from (≤ 10, ≤ 2 MB together); every agent on the mission gets them. */
  files: z.array(InputFile).max(MAX_INPUT_FILES).optional(),
  /**
   * A saved pipeline (PRD F5): `adapt` (default) has the planner follow its shape for this goal; `as_is` proposes its
   * plan unchanged.
   */
  template: z.object({ id: z.uuid(), mode: z.enum(["adapt", "as_is"]).default("adapt") }).optional(),
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
  if (body.routing.strategy === "crew") {
    const [crew] = await ctx.db
      .select({ id: schema.crews.id })
      .from(schema.crews)
      .where(
        and(
          eq(schema.crews.id, body.routing.crewId),
          eq(schema.crews.workspaceId, workspaceId),
          isNull(schema.crews.deletedAt),
        ),
      );
    if (!crew) throw new HttpError(422, "the crew is not in this workspace", "unknown_crew");
  }
  if (body.template && body.plan)
    throw new HttpError(422, "start from a template or from a plan, not both", "template_and_plan");
  const template = body.template ? await templateFor(ctx, workspaceId, body.template.id) : undefined;
  // As is, the template's plan is the mission's plan v1 (pins to agents that are gone are dropped).
  const plan =
    body.plan ??
    (template && body.template?.mode === "as_is"
      ? await withLivePins(ctx, workspaceId, template.graph)
      : undefined);
  const issue = body.issueUrl ? await readIssue(ctx, workspaceId, body.issueUrl, body.projectId) : undefined;
  const mission = await ctx.db.transaction(async (tx) => {
    const files = body.files?.length ? await storeInputFiles(tx, workspaceId, body.files) : undefined;
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
          inputs: {
            ...(issue ? { issue } : {}),
            ...(files ? { files } : {}),
            ...(template && body.template
              ? { template: { id: template.id, name: template.name, mode: body.template.mode } }
              : {}),
          },
          status: plan ? "awaiting_approval" : "planning",
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
      payload: {
        title: m.title,
        goal: m.goal,
        priority: m.priority,
        budget: m.budget,
        routing: m.routing,
        ...(issue ? { issue: issue.url } : {}),
        ...(files ? { files: files.map((f) => f.name) } : {}),
      },
    });
    if (plan) await storePlan(ctx, tx, m, plan, body.plan ? "supplied" : "template", actor);
    return m;
  });
  if (!plan) await ctx.orchestrator.startMission(mission);
  return mission;
}

/** Cancels a mission a person (or an A2A caller) gave up on; its running work stops on the orchestrator's next pass. */
export async function cancelMission(ctx: AppContext, m: typeof missions.$inferSelect, actor: Actor) {
  const [done] = await ctx.db
    .update(missions)
    .set({ status: "cancelled" })
    .where(and(eq(missions.id, m.id), eq(missions.status, m.status)))
    .returning();
  if (!done) throw new HttpError(409, "the mission changed; try again", "conflict");
  await ctx.events.append(ctx.db, {
    workspaceId: m.workspaceId,
    missionId: m.id,
    type: "mission.failed",
    actor,
    payload: { reason: "cancelled by a person" },
  });
}

async function templateFor(ctx: AppContext, workspaceId: string, id: string) {
  const [t] = await ctx.db
    .select()
    .from(schema.templates)
    .where(
      and(
        eq(schema.templates.id, id),
        eq(schema.templates.workspaceId, workspaceId),
        isNull(schema.templates.deletedAt),
      ),
    );
  if (!t) throw new HttpError(404, "template not found", "not_found");
  return t;
}

/** The plan without pins to agents the workspace no longer has. */
async function withLivePins(ctx: AppContext, workspaceId: string, graph: PlanGraph): Promise<PlanGraph> {
  const live = new Set(
    (
      await ctx.db
        .select({ id: schema.agents.id })
        .from(schema.agents)
        .where(and(eq(schema.agents.workspaceId, workspaceId), isNull(schema.agents.deletedAt)))
    ).map((a) => a.id),
  );
  return {
    ...graph,
    tasks: graph.tasks.map(({ pinnedAgentId, ...t }) =>
      pinnedAgentId && live.has(pinnedAgentId) ? { ...t, pinnedAgentId } : t,
    ),
  };
}
