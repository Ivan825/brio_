// Plan versions (BUILD_PLAN M3): every planner proposal and every user edit is a new version with its lint result;
// approving one materialises its tasks. Pure helpers plus the database writes.
import { applyPlanEdit, type LintResult, lintPlan, type PlanEdit } from "@brio/core";
import { type DbOrTx, schema } from "@brio/db";
import type { Actor, EventType, PlanGraph } from "@brio/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { AppContext } from "../context";
import { HttpError } from "../http";

const { missions, plans, tasks } = schema;

export type PlanRow = typeof plans.$inferSelect;

export function lintSummary(l: LintResult) {
  return { errors: l.errors, warnings: l.warnings, fixes: l.fixes, estimate: l.estimate };
}

export async function latestPlan(db: DbOrTx, missionId: string): Promise<PlanRow | undefined> {
  const [p] = await db
    .select()
    .from(plans)
    .where(eq(plans.missionId, missionId))
    .orderBy(desc(plans.version))
    .limit(1);
  return p;
}

/** Stores a new proposed version (superseding older proposals) and records the event. */
export async function storePlan(
  ctx: AppContext,
  tx: DbOrTx,
  mission: typeof missions.$inferSelect,
  graph: PlanGraph,
  origin: "planner" | "user",
  actor: Actor,
): Promise<{ plan: PlanRow; lint: LintResult }> {
  const lint = lintPlan(graph, {
    ...(mission.budget.usd !== undefined ? { budgetUsd: mission.budget.usd } : {}),
  });
  const prev = await latestPlan(tx, mission.id);
  await tx
    .update(plans)
    .set({ status: "superseded" })
    .where(and(eq(plans.missionId, mission.id), eq(plans.status, "proposed")));
  const [plan] = await tx
    .insert(plans)
    .values({
      workspaceId: mission.workspaceId,
      missionId: mission.id,
      version: (prev?.version ?? 0) + 1,
      graph: lint.graph,
      status: "proposed",
      origin,
      lint: lintSummary(lint) as unknown as Record<string, unknown>,
    })
    .returning();
  if (!plan) throw new Error("plan insert returned nothing");
  const type: EventType = origin === "planner" ? "plan.proposed" : "plan.edited";
  await ctx.events.append(tx, {
    workspaceId: mission.workspaceId,
    missionId: mission.id,
    type,
    actor,
    payload: {
      version: plan.version,
      tasks: lint.graph.tasks.map((t) => ({
        key: t.key,
        type: t.type,
        title: t.title,
        dependsOn: t.dependsOn,
      })),
      assumptions: lint.graph.assumptions,
      questions: lint.graph.questions,
      lint: { errors: lint.errors.length, warnings: lint.warnings.length, fixes: lint.fixes.length },
      estimate: lint.estimate,
    },
  });
  return { plan, lint };
}

export async function editPlan(
  ctx: AppContext,
  mission: typeof missions.$inferSelect,
  version: number,
  edits: PlanEdit[],
  actor: Actor,
) {
  return ctx.db.transaction(async (tx) => {
    const latest = await latestPlan(tx, mission.id);
    if (!latest || latest.version !== version || latest.status !== "proposed")
      throw new HttpError(409, "edit the latest proposed plan", "stale_plan");
    let graph = latest.graph;
    for (const e of edits) graph = applyPlanEdit(graph, e);
    // Pins must name this workspace's agents.
    const pins = graph.tasks.map((t) => t.pinnedAgentId).filter((x): x is string => Boolean(x));
    if (pins.length) {
      const found = await tx
        .select({ id: schema.agents.id })
        .from(schema.agents)
        .where(and(eq(schema.agents.workspaceId, mission.workspaceId), inArray(schema.agents.id, pins)));
      if (found.length !== new Set(pins).size)
        throw new HttpError(422, "a pinned agent is not in this workspace", "unknown_agent");
    }
    return storePlan(ctx, tx, mission, graph, "user", actor);
  });
}

/** Approves a version: its tasks become real (dependsOn keys → ids) and the mission starts. */
export async function approvePlan(
  ctx: AppContext,
  mission: typeof missions.$inferSelect,
  version: number,
  actor: Actor,
  userId: string | null,
) {
  return ctx.db.transaction(async (tx) => {
    const [plan] = await tx
      .select()
      .from(plans)
      .where(and(eq(plans.missionId, mission.id), eq(plans.version, version)));
    if (!plan) throw new HttpError(404, "no such plan version", "not_found");
    if (plan.status !== "proposed")
      throw new HttpError(409, `plan v${version} is ${plan.status}`, "plan_not_proposed");
    const lint = plan.lint as { errors?: unknown[] };
    if (lint.errors?.length)
      throw new HttpError(422, "fix the plan's errors before approving it", "plan_has_errors");
    const [locked] = await tx
      .update(missions)
      .set({ status: "running", blockedReason: null })
      .where(and(eq(missions.id, mission.id), eq(missions.status, "awaiting_approval")))
      .returning();
    if (!locked) throw new HttpError(409, "the mission is not waiting for approval", "not_awaiting_approval");
    await tx.update(plans).set({ status: "approved", approvedBy: userId }).where(eq(plans.id, plan.id));

    const inserted = await tx
      .insert(tasks)
      .values(
        plan.graph.tasks.map((t) => ({
          workspaceId: mission.workspaceId,
          missionId: mission.id,
          planVersion: version,
          key: t.key,
          type: t.type,
          title: t.title,
          contract: t.contract,
          mode: t.suggestedMode,
          pinnedAgentId: t.pinnedAgentId ?? null,
          budget: t.contract.budget ?? {},
        })),
      )
      .returning({ id: tasks.id, key: tasks.key });
    const idOf = new Map(inserted.map((r) => [r.key, r.id]));
    for (const t of plan.graph.tasks)
      if (t.dependsOn.length)
        await tx
          .update(tasks)
          .set({ dependsOn: t.dependsOn.map((k) => idOf.get(k) as string) })
          .where(eq(tasks.id, idOf.get(t.key) as string));

    const base = { workspaceId: mission.workspaceId, missionId: mission.id, actor };
    await ctx.events.append(tx, {
      ...base,
      type: "plan.approved",
      payload: { version, tasks: inserted.length },
    });
    await ctx.events.append(tx, { ...base, type: "mission.started", actor: "system", payload: { version } });
    return plan;
  });
}
