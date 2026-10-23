// Plan versions (BUILD_PLAN M3): every planner proposal and every user edit is a new version with its lint result;
// approving one materialises its tasks. Pure helpers plus the database writes.
import { applyPlanEdit, type LintResult, lintPlan, type PlanEdit } from "@brio/core";
import { type DbOrTx, schema } from "@brio/db";
import { type Actor, type EventType, type PlanGraph, TaskContract } from "@brio/schema";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { AppContext } from "../context";
import { HttpError } from "../http";

const { attempts, missions, plans, tasks } = schema;

/** JSON with sorted keys, so two equal contracts compare equal whatever order their fields came in. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

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
  origin: "planner" | "user" | "replan" | "supplied" | "template",
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
  const type: EventType = origin === "user" ? "plan.edited" : "plan.proposed";
  // (A supplied plan is proposed like a planner's: made elsewhere, approved here.)
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
      ...(origin === "replan" ? { replan: true } : {}),
      ...(origin === "supplied" ? { supplied: true } : {}),
      ...(origin === "template" ? { template: true } : {}),
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

    // A replan keeps finished work: a done task of the previous approved version that the new plan keeps unchanged
    // (same key, type and contract) is carried over as done, with its result, instead of running again.
    const [prev] = await tx
      .select()
      .from(plans)
      .where(and(eq(plans.missionId, mission.id), eq(plans.status, "approved"), lt(plans.version, version)))
      .orderBy(desc(plans.version))
      .limit(1);
    const carried = new Map<string, { id: string; resultArtifactId: string | null; attemptId: string }>();
    if (prev) {
      const old = await tx
        .select()
        .from(tasks)
        .where(
          and(eq(tasks.missionId, mission.id), eq(tasks.planVersion, prev.version), eq(tasks.status, "done")),
        );
      for (const t of plan.graph.tasks) {
        const o = old.find((x) => x.key === t.key);
        if (!o || o.type !== t.type) continue;
        if (canonical(TaskContract.parse(o.contract)) !== canonical(TaskContract.parse(t.contract))) continue;
        const picked = (o.modeParams as { result?: { attemptId: string } }).result?.attemptId;
        const [a] = picked
          ? [{ id: picked }]
          : await tx
              .select({ id: attempts.id })
              .from(attempts)
              .where(
                and(
                  eq(attempts.taskId, o.id),
                  eq(attempts.status, "succeeded"),
                  sql`coalesce(${attempts.dispatch}->'mode'->>'purpose', 'make') in ('make', 'revise', 'merge')`,
                ),
              )
              .orderBy(desc(attempts.endedAt))
              .limit(1);
        if (a) carried.set(t.key, { id: o.id, resultArtifactId: o.resultArtifactId, attemptId: a.id });
      }
    }

    const inserted = await tx
      .insert(tasks)
      .values(
        plan.graph.tasks.map((t) => {
          const c = carried.get(t.key);
          return {
            workspaceId: mission.workspaceId,
            missionId: mission.id,
            planVersion: version,
            key: t.key,
            type: t.type,
            title: t.title,
            contract: t.contract,
            mode: t.suggestedMode,
            modeParams: c
              ? {
                  ...(t.modeParams ?? {}),
                  carriedFrom: c.id,
                  result: { attemptId: c.attemptId, note: `carried over from plan v${prev?.version}` },
                }
              : (t.modeParams ?? {}),
            pinnedAgentId: t.pinnedAgentId ?? null,
            budget: t.contract.budget ?? {},
            ...(c ? { status: "done" as const, resultArtifactId: c.resultArtifactId } : {}),
          };
        }),
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
      payload: { version, tasks: inserted.length, ...(carried.size ? { carried: [...carried.keys()] } : {}) },
    });
    await ctx.events.append(tx, { ...base, type: "mission.started", actor: "system", payload: { version } });
    return plan;
  });
}

/**
 * Whether a proposed plan starts without a person (a quick start): the mission asked for it, and the plan is clean
 * (no lint errors, no questions) and small (at most $5 and 10 tasks).
 */
export function quickStarts(
  m: { autoApprove: boolean },
  plan: { graph: PlanGraph; lint: { errors?: unknown[] | number; estimate?: { usd: number } | null } },
): boolean {
  const errors = Array.isArray(plan.lint.errors) ? plan.lint.errors.length : (plan.lint.errors ?? 0);
  return (
    m.autoApprove &&
    !errors &&
    !plan.graph.questions.length &&
    (plan.lint.estimate?.usd ?? 0) <= 5 &&
    plan.graph.tasks.length <= 10
  );
}

/**
 * Whether a mission is really waiting for a person to approve its plan, not passing through on a quick start (its
 * plan is stored, then approved a moment later).
 */
export async function awaitingPerson(db: DbOrTx, m: typeof missions.$inferSelect): Promise<boolean> {
  if (m.status !== "awaiting_approval") return false;
  const p = await latestPlan(db, m.id);
  if (!p || p.status !== "proposed") return false;
  return !quickStarts(m, {
    graph: p.graph,
    lint: p.lint as { errors?: unknown[]; estimate?: { usd: number } | null },
  });
}
