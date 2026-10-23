// The orchestrator loop (ARCHITECTURE §4.1, §4.2). It holds no state of its own: every tick reads the mission from the
// database, asks the pure scheduler what to do, and applies each action with a conditional update. So it can crash,
// run twice, or restart mid-mission, and the mission carries on from where the database says it is.
import { randomUUID } from "node:crypto";
import type { AttemptChecks, Dispatch } from "@brio/adapters";
import {
  type Assignment,
  buildHandoff,
  type Candidate,
  choosePlanner,
  decide,
  freshScore,
  judgeInstructions,
  LEASE_BLOCK,
  type LearnedDecision,
  MAX_REROUTES,
  MAX_REVISIONS,
  type Mode,
  type ModeAction,
  type ModeAttempt,
  mergeInstructions,
  nextStep,
  parseJudgment,
  parsePlan,
  parseVerdict,
  plannerInstructions,
  reviewInstructions,
  routeLearned,
  type SchedTask,
  seeded,
  stepInstructions,
  verdict,
} from "@brio/core";
import { type DbOrTx, schema } from "@brio/db";
import { type Actor, type EventType, type HandoffPacket, TaskContract } from "@brio/schema";
import { and, asc, desc, eq, gt, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { RUNNABLE_TASK, renderInstructions } from "../attempts";
import type { AppContext } from "../context";
import { HttpError } from "../http";
import { routeAgents, type WorkspaceAgent } from "./agents";
import { approvePlan, latestPlan, storePlan } from "./plans";
import { attemptAgentKey, Scoreboard } from "./scoreboard";
import { Verifier } from "./verifier";

const { artifacts, attempts, blobs, contracts, handoffs, leases, missions, tasks } = schema;

type Mission = typeof missions.$inferSelect;
type Task = typeof tasks.$inferSelect;
type Attempt = typeof attempts.$inferSelect;

export const PLANNING_TASK_KEY = "brio.plan";
/** Revised plans the planner may propose after a task fails for good. */
export const MAX_REPLANS = 1;
/** Planner retries when its answer is not a valid plan. */
export const MAX_PLANNING_RETRIES = 2;
const MAX_PARALLEL = 4;
const LEASE_TTL_MS = 6 * 3600_000;
const COMMAND_CHECKS = new Set(["tests", "typecheck", "lint", "build"]);

const isCodeTask = (t: Pick<Task, "type">) => t.type.startsWith("code.") || t.type === "merge.integrate";
const footprintOf = (t: Task) => TaskContract.parse(t.contract).expectedFootprint?.paths ?? [];

/** How a task was routed (kept on tasks.mode_params.route): its mode, who plays which role, and why. */
export interface TaskRoute {
  mode: Mode;
  agents: Assignment[];
  rationale: string;
  degraded?: string;
  estUsd: number;
  /** Attempts created from here on belong to this route (a person's revise or a replan routes again). */
  startedAt: string;
}
/** The attempt a multi-agent mode settled on, which the verifier then checks like a single attempt. */
export interface ModeResult {
  attemptId: string;
  note: string;
}
type ModeParams = {
  route?: TaskRoute;
  result?: ModeResult;
  /** Things done once per task (Elo updates, review rows), so a re-run tick does not repeat them. */
  marks?: string[];
  n?: number;
  steps?: Array<{ agentId: string }>;
  explicit?: boolean;
  /** Times the task moved to another agent after failing its revisions (ROUTING §4.2). */
  reroutes?: number;
  /** Set when the task must move: the next dispatch avoids these agents and tells the new one what failed. */
  reroute?: { exclude: string[]; reasons: string[] };
  /** The task failed for good (no more revisions, agents or mode steps). */
  final?: boolean;
  /** The task was done in an earlier plan version and carried over unchanged (approvePlan). */
  carriedFrom?: string;
};
const paramsOf = (t: Task) => t.modeParams as ModeParams;
/** Attempts that made a result (single-mode makers and a mode's makers and mergers), not reviewers or judges. */
const MADE = sql`coalesce(${attempts.dispatch}->'mode'->>'purpose', 'make') in ('make', 'revise', 'merge')`;
const multi = (t: Task) => {
  const r = paramsOf(t).route;
  return r !== undefined && r.mode !== "single";
};
/** A stable seed per task and revision, so a route can be reproduced from the database. */
const seedOf = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

export interface OrchestratorOptions {
  sweepMs?: number;
}

export class Orchestrator {
  private readonly busy = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private stopped = false;
  readonly scores: Scoreboard;
  private readonly verifier: Verifier;

  constructor(
    private readonly ctx: AppContext,
    private readonly opts: OrchestratorOptions = {},
  ) {
    this.scores = new Scoreboard(ctx);
    this.verifier = new Verifier(
      ctx,
      (db, m, type, payload, extra) => this.emit(db, m, type, payload, extra),
      this.scores,
    );
  }

  /** Reacts to every new event, and sweeps active missions so nothing waits on a missed notification. */
  start(): void {
    this.stopped = false;
    this.unsubscribe = this.ctx.feed.subscribeAll((missionId) => this.schedule(missionId));
    this.timer = setInterval(() => void this.sweep(), this.opts.sweepMs ?? 3000);
    this.timer.unref();
    void this.sweep();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.busy.values()]);
  }

  async sweep(): Promise<void> {
    if (this.stopped) return;
    const active = await this.ctx.db
      .select({ id: missions.id })
      .from(missions)
      .where(inArray(missions.status, ["planning", "running", "draft"]))
      .catch(() => []);
    for (const m of active) this.schedule(m.id);
  }

  /** Runs a tick for the mission; ticks of one mission never overlap, and a request during a tick runs one more. */
  schedule(missionId: string): void {
    if (this.stopped) return;
    if (this.busy.has(missionId)) {
      this.dirty.add(missionId);
      return;
    }
    const run = (async () => {
      do {
        this.dirty.delete(missionId);
        try {
          await this.tick(missionId);
        } catch (err) {
          this.ctx.log.error({ err: (err as Error).message, missionId }, "orchestrator tick failed");
        }
      } while (this.dirty.has(missionId) && !this.stopped);
    })().finally(() => this.busy.delete(missionId));
    this.busy.set(missionId, run);
  }

  /** Waits until a mission has no tick in flight (tests). */
  async idle(missionId: string): Promise<void> {
    await this.busy.get(missionId);
  }

  private emit(
    db: DbOrTx,
    m: Pick<Mission, "id" | "workspaceId">,
    type: EventType,
    payload: Record<string, unknown>,
    extra: { taskId?: string; attemptId?: string; actor?: Actor } = {},
  ) {
    return this.ctx.events.append(db, {
      workspaceId: m.workspaceId,
      missionId: m.id,
      type,
      actor: extra.actor ?? "system",
      payload,
      taskId: extra.taskId ?? null,
      attemptId: extra.attemptId ?? null,
    });
  }

  async tick(missionId: string): Promise<void> {
    const [m] = await this.ctx.db.select().from(missions).where(eq(missions.id, missionId));
    if (!m) return;
    if (m.status === "planning" || m.status === "draft") return this.planningStep(m);
    if (m.status === "running") return this.runningStep(m);
  }

  // ---- Planning -------------------------------------------------------------------------------------------------

  /** Creates the mission's planning task (plan version 0) and starts planning. */
  async startMission(m: Mission): Promise<void> {
    await this.ctx.db
      .insert(tasks)
      .values({
        workspaceId: m.workspaceId,
        missionId: m.id,
        planVersion: 0,
        key: PLANNING_TASK_KEY,
        type: "plan.decompose",
        title: "Plan the mission",
        contract: {
          objective: m.goal,
          inputs: [{ kind: "text", ref: "mission.goal" }],
          outputs: [{ kind: "report", description: "the plan as JSON" }],
          acceptance: [{ kind: "human", hard: true }],
          constraints: [],
          sensitivity: "internal",
        },
      })
      .onConflictDoNothing();
    this.schedule(m.id);
  }

  private async planningTask(missionId: string): Promise<Task | undefined> {
    const [t] = await this.ctx.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.missionId, missionId), eq(tasks.planVersion, 0), eq(tasks.key, PLANNING_TASK_KEY)));
    return t;
  }

  /** The task's latest made attempt (the verifier's reviewer attempts are not results). */
  private async latestAttempt(taskId: string): Promise<Attempt | undefined> {
    const [a] = await this.ctx.db
      .select()
      .from(attempts)
      .where(and(eq(attempts.taskId, taskId), MADE))
      .orderBy(desc(attempts.createdAt))
      .limit(1);
    return a;
  }

  private async attemptOutput(a: Attempt): Promise<string> {
    const [row] = await this.ctx.db
      .select({ bytes: blobs.bytes })
      .from(artifacts)
      .innerJoin(blobs, and(eq(blobs.workspaceId, artifacts.workspaceId), eq(blobs.sha256, artifacts.sha256)))
      .where(and(eq(artifacts.attemptId, a.id), eq(artifacts.kind, "report")));
    return row?.bytes.toString("utf8") ?? "";
  }

  private async block(m: Mission, reason: string): Promise<void> {
    const [changed] = await this.ctx.db
      .update(missions)
      .set({ blockedReason: reason, ...(m.status === "planning" ? { status: "draft" } : {}) })
      .where(
        and(eq(missions.id, m.id), or(isNull(missions.blockedReason), ne(missions.blockedReason, reason))),
      )
      .returning();
    if (changed) await this.emit(this.ctx.db, m, "mission.blocked", { reason });
  }

  private async planningStep(m: Mission): Promise<void> {
    const task = await this.planningTask(m.id);
    if (!task) return this.startMission(m);

    if (task.status === "pending" || task.status === "ready") return this.dispatchPlanner(m, task);
    if (task.status === "running") return;

    const attempt = await this.latestAttempt(task.id);
    if (task.status === "verifying" && attempt?.status === "succeeded") {
      const parsed = parsePlan(await this.attemptOutput(attempt));
      if (parsed.ok) {
        const done = await this.ctx.db.transaction(async (tx) => {
          const [claimed] = await tx
            .update(tasks)
            .set({ status: "done", revisions: 0 })
            .where(and(eq(tasks.id, task.id), eq(tasks.status, "verifying")))
            .returning();
          if (!claimed) return null;
          const stored = await storePlan(
            this.ctx,
            tx,
            m,
            parsed.graph,
            (m.report as { replan?: unknown } | null)?.replan ? "replan" : "planner",
            `agent:${attempt.agentId}`,
          );
          await tx
            .update(missions)
            .set({ status: "awaiting_approval", blockedReason: null })
            .where(eq(missions.id, m.id));
          return stored;
        });
        if (done && m.autoApprove && !done.lint.errors.length && !done.plan.graph.questions.length) {
          const small = (done.lint.estimate?.usd ?? 0) <= 5 && done.plan.graph.tasks.length <= 10;
          if (small)
            await approvePlan(
              this.ctx,
              { ...m, status: "awaiting_approval" },
              done.plan.version,
              "system",
              null,
            ).catch(() => {});
        }
        return;
      }
      return this.retryPlanning(m, task, parsed.errors);
    }
    if (task.status === "failed" || (task.status === "verifying" && attempt?.status !== "succeeded"))
      return this.retryPlanning(m, task, [attempt?.exitReason ?? "the planner did not finish"]);
  }

  private async retryPlanning(m: Mission, task: Task, errors: string[]): Promise<void> {
    if (task.revisions >= MAX_PLANNING_RETRIES) {
      const [claimed] = await this.ctx.db
        .update(tasks)
        .set({ status: "failed" })
        .where(and(eq(tasks.id, task.id), ne(tasks.status, "failed")))
        .returning();
      if (claimed) {
        await this.ctx.db
          .update(missions)
          .set({ status: "draft", blockedReason: "planning failed" })
          .where(eq(missions.id, m.id));
        await this.emit(this.ctx.db, m, "plan.failed", { errors: errors.slice(0, 10) });
      }
      return;
    }
    const [claimed] = await this.ctx.db
      .update(tasks)
      .set({ status: "ready", revisions: task.revisions + 1, blockedReason: errors.slice(0, 10).join("\n") })
      .where(and(eq(tasks.id, task.id), inArray(tasks.status, ["verifying", "failed"])))
      .returning();
    if (claimed) this.schedule(m.id);
  }

  private async dispatchPlanner(m: Mission, task: Task): Promise<void> {
    const agents = await routeAgents(this.ctx, m.workspaceId);
    const route = choosePlanner(agents, m.plannerAgentId);
    if (!route.ok) return this.block(m, `planning: ${route.reason}`);
    let repo = false;
    if (m.projectId) {
      const [p] = await this.ctx.db.select().from(schema.projects).where(eq(schema.projects.id, m.projectId));
      repo = Boolean(p?.repoUrl);
    }
    const feedback = task.revisions > 0 && task.blockedReason ? task.blockedReason.split("\n") : undefined;
    const { plannerNotes: notes, replan } = (m.report ?? {}) as {
      plannerNotes?: string[];
      replan?: { failed: { key: string; title: string; reasons: string[] }; done: unknown[] };
    };
    const instructions = plannerInstructions({
      goal: m.goal,
      repoFiles: [],
      repoAttached: repo,
      availableTaskTypes: [...new Set(agents.filter((a) => a.runnable).flatMap((a) => a.taskTypes))],
      ...(m.budget.usd !== undefined ? { budgetUsd: m.budget.usd } : {}),
      ...(feedback ? { feedback } : {}),
      ...(notes?.length ? { userNotes: notes } : {}),
      ...(replan ? { replan } : {}),
    });
    try {
      if (m.status === "draft" || m.blockedReason)
        await this.ctx.db
          .update(missions)
          .set({ status: "planning", blockedReason: null })
          .where(eq(missions.id, m.id));
      await this.ctx.attempts.start({
        workspaceId: m.workspaceId,
        taskId: task.id,
        agentId: route.agentId,
        actor: "system",
        instructions,
        repoMap: repo,
        rationale: route.rationale,
      });
    } catch (err) {
      if (err instanceof HttpError) return this.block(m, `planning: ${err.message}`);
      throw err;
    }
  }

  /** Throws the plan away and plans again, with the user's notes. */
  async replan(m: Mission, notes: string[], actor: Actor): Promise<void> {
    await this.ctx.db.transaction(async (tx) => {
      const latest = await latestPlan(tx, m.id);
      if (latest?.status === "proposed") {
        await tx.update(schema.plans).set({ status: "rejected" }).where(eq(schema.plans.id, latest.id));
        await this.emit(tx, m, "plan.rejected", { version: latest.version, notes }, { actor });
      }
      const prior = (m.report as { plannerNotes?: string[] } | null)?.plannerNotes ?? [];
      await tx
        .update(missions)
        .set({
          status: "planning",
          blockedReason: null,
          report: { ...(m.report ?? {}), plannerNotes: [...prior, ...notes] },
        })
        .where(eq(missions.id, m.id));
      await tx
        .update(tasks)
        .set({ status: "ready", revisions: 0, blockedReason: null })
        .where(and(eq(tasks.missionId, m.id), eq(tasks.planVersion, 0)));
    });
    this.schedule(m.id);
  }

  // ---- Running ---------------------------------------------------------------------------------------------------

  private async runningStep(m: Mission): Promise<void> {
    const plan = await latestApproved(this.ctx.db, m.id);
    if (!plan) return;
    const rows = await this.ctx.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.missionId, m.id), eq(tasks.planVersion, plan.version)))
      .orderBy(asc(tasks.createdAt));

    // Verification first: it moves tasks to done, revise or failed, which the scheduler then acts on.
    for (const t of rows) if (t.status === "verifying") await this.verify(m, t);
    // Multi-agent modes move on as their attempts and checks finish.
    for (const t of rows) if (t.status === "running" && multi(t)) await this.modeStep(m, t);
    for (const t of rows)
      if (t.status === "failed" && !paramsOf(t).final) await this.reviseAfterFailedAttempt(m, t);

    const fresh = await this.ctx.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.missionId, m.id), eq(tasks.planVersion, plan.version)))
      .orderBy(asc(tasks.createdAt));
    // Leases of tasks still at work are renewed (their heartbeat); leases of everything else lapse on their own.
    const working = fresh
      .filter((t) => ["running", "verifying", "revise", "leased"].includes(t.status))
      .map((t) => t.id);
    if (working.length)
      await this.ctx.db
        .update(leases)
        .set({ expiresAt: new Date(Date.now() + LEASE_TTL_MS) })
        .where(
          and(
            inArray(leases.taskId, working),
            isNull(leases.releasedAt),
            sql`${leases.expiresAt} < now() + interval '2 hours'`,
          ),
        );
    const held = await this.ctx.db
      .select({ taskId: leases.taskId, resource: leases.resource })
      .from(leases)
      .where(
        and(
          eq(leases.workspaceId, m.workspaceId),
          isNull(leases.releasedAt),
          gt(leases.expiresAt, new Date()),
        ),
      );
    // Tasks carried over from an earlier plan version hand their work to the new plan's tasks once.
    for (const t of fresh)
      if (paramsOf(t).carriedFrom && t.status === "done" && (await this.markOnce(t.id, "handed-off")))
        await this.handOffCarried(m, t);
    const snapshot: SchedTask[] = fresh.map((t) => ({
      id: t.id,
      key: t.key,
      status: t.status,
      dependsOn: t.dependsOn,
      footprint: footprintOf(t),
      isCode: isCodeTask(t),
      blockedReason: t.blockedReason,
    }));
    const actions = decide({
      missionStatus: m.status,
      tasks: snapshot,
      heldLeases: held,
      maxParallel: MAX_PARALLEL,
    });
    const byId = new Map(fresh.map((t) => [t.id, t]));

    for (const a of actions) {
      switch (a.kind) {
        case "ready": {
          const [t] = await this.ctx.db
            .update(tasks)
            .set({ status: "ready" })
            .where(and(eq(tasks.id, a.taskId), eq(tasks.status, "pending")))
            .returning();
          if (t) await this.emit(this.ctx.db, m, "task.ready", { taskKey: t.key }, { taskId: t.id });
          break;
        }
        case "block": {
          const [t] = await this.ctx.db
            .update(tasks)
            .set({ status: "blocked", blockedReason: a.reason })
            .where(and(eq(tasks.id, a.taskId), inArray(tasks.status, ["ready", "blocked", "pending"])))
            .returning();
          if (t) {
            await this.emit(
              this.ctx.db,
              m,
              "task.blocked",
              { taskKey: t.key, reason: a.reason },
              { taskId: t.id },
            );
            if (a.reason.startsWith(LEASE_BLOCK))
              await this.emit(
                this.ctx.db,
                m,
                "lease.denied",
                { taskKey: t.key, footprint: footprintOf(t) },
                { taskId: t.id },
              );
          }
          break;
        }
        case "unblock":
          await this.ctx.db
            .update(tasks)
            .set({ status: "ready", blockedReason: null })
            .where(and(eq(tasks.id, a.taskId), eq(tasks.status, "blocked")));
          break;
        case "dispatch": {
          const t = byId.get(a.taskId);
          if (t) await this.dispatch(m, t);
          break;
        }
        case "mission_done":
          await this.finishMission(m);
          break;
        case "mission_failed": {
          if (await this.proposeReplan(m, fresh, a.reason)) break;
          const [done] = await this.ctx.db
            .update(missions)
            .set({ status: "failed", blockedReason: a.reason })
            .where(and(eq(missions.id, m.id), eq(missions.status, "running")))
            .returning();
          if (done) {
            await this.releaseMissionLeases(m);
            await this.emit(this.ctx.db, m, "mission.failed", { reason: a.reason });
          }
          break;
        }
      }
    }
  }

  private async dispatch(m: Mission, task: Task): Promise<void> {
    const fresh = (await this.ctx.db.select().from(tasks).where(eq(tasks.id, task.id)))[0];
    if (!fresh || !(RUNNABLE_TASK as readonly string[]).includes(fresh.status)) return;
    const revising = fresh.status === "revise";
    // A reroute goes to another agent, from scratch; a revision goes back to the agent that made the result (the
    // mode's pick, or the last attempt) and builds on it.
    const rerouting = revising ? paramsOf(fresh).reroute : undefined;
    const previous = revising && !rerouting ? await this.resultAttempt(fresh, false) : undefined;
    const agents = await routeAgents(this.ctx, m.workspaceId);
    const contract = TaskContract.parse(fresh.contract);
    const decision = await this.route(
      m,
      fresh,
      contract,
      rerouting ? agents.filter((a) => !rerouting.exclude.includes(a.id)) : agents,
      rerouting ? null : (previous?.agentId ?? fresh.pinnedAgentId),
      Boolean(rerouting),
    );
    if (!decision.ok) {
      if (rerouting) {
        const last = await this.latestAttempt(fresh.id);
        if (last)
          await this.sendBack(m, fresh, last, "fail", [
            ...rerouting.reasons,
            `no other agent to take it: ${decision.reason}`,
          ]);
        return;
      }
      await this.blockTask(m, fresh, `route: ${decision.reason}`);
      return;
    }
    const route: TaskRoute = {
      mode: decision.mode,
      agents: decision.agents,
      rationale: decision.rationale,
      ...(decision.degraded ? { degraded: decision.degraded } : {}),
      estUsd: decision.estUsd,
      startedAt: new Date().toISOString(),
    };
    const said =
      revising && previous
        ? `${route.rationale.replace(/ \(pinned\)$/, "")} revises its own result`
        : route.rationale;
    const rationale = route.degraded ? `${said} · ${route.degraded}` : said;

    const granted = isCodeTask(fresh) ? await this.acquireLeases(m, fresh) : [];
    if (granted === null) return; // lost a race for the files; the next tick blocks or retries it
    const { result: _result, marks: _marks, reroute: _reroute, ...kept } = paramsOf(fresh);
    const params = { ...kept, route };

    if (route.mode !== "single") {
      // The task runs as a whole; its attempts are the mode's to start.
      const [claimed] = await this.ctx.db
        .update(tasks)
        .set({ status: "running", modeParams: params })
        .where(and(eq(tasks.id, fresh.id), inArray(tasks.status, [...RUNNABLE_TASK])))
        .returning();
      if (!claimed) {
        if (granted.length) await this.releaseLeases(m, fresh, "dispatch lost a race");
        return;
      }
      await this.emitRouted(m, claimed, route, agents);
      await this.modeStep(m, claimed);
      return;
    }

    await this.ctx.db.update(tasks).set({ modeParams: params }).where(eq(tasks.id, fresh.id));
    await this.emitRouted(m, fresh, route, agents);
    const inputs = await this.taskInputs(m, fresh, contract);
    try {
      await this.ctx.attempts.start({
        workspaceId: m.workspaceId,
        taskId: fresh.id,
        agentId: (route.agents[0] as Assignment).agentId,
        actor: "system",
        handoffs: inputs.packets,
        // A revision builds on the work it revises.
        bases: [...inputs.bases, ...(revising && previous?.worktreeRef ? [previous.worktreeRef] : [])],
        files: inputs.files,
        rationale: rerouting ? `${rationale} · rerouted after another agent failed` : rationale,
        ...(revising && previous ? { feedback: failedChecksFeedback(previous) } : {}),
        ...(rerouting
          ? {
              instructions: `${renderInstructions(fresh, contract, m.goal)}\n\n## Another agent tried this task first and failed\n${rerouting.reasons.map((r) => `- ${r}`).join("\n")}\nStart from the task as described; avoid those failures.`,
            }
          : {}),
      });
    } catch (err) {
      if (granted.length) await this.releaseLeases(m, fresh, "dispatch failed");
      if (err instanceof HttpError) await this.blockTask(m, fresh, `dispatch: ${err.message}`);
      else throw err;
    }
  }

  /** The learned router over the workspace's agents, with their scores on this task type and the budget left. */
  private async route(
    m: Mission,
    t: Task,
    contract: TaskContract,
    agents: WorkspaceAgent[],
    pinnedAgentId: string | null,
    /** A reroute runs one agent on its own. */
    single = false,
  ): Promise<LearnedDecision> {
    const now = new Date();
    const scored = await this.scores.get(
      m.workspaceId,
      [...new Set(agents.map((a) => a.scoreKey))],
      t.type,
      now,
    );
    const candidates: Candidate[] = agents.map((a) => ({
      agent: a,
      score: scored.get(a.scoreKey) ?? freshScore(now),
      healthy: a.healthy,
      estUsd: a.estUsd,
    }));
    let remainingUsd: number | undefined;
    if (m.budget.usd !== undefined) {
      const [spent] = await this.ctx.db
        .select({ usd: sql<number>`coalesce(sum(${attempts.costUsd}), 0)::float` })
        .from(attempts)
        .innerJoin(tasks, eq(tasks.id, attempts.taskId))
        .where(eq(tasks.missionId, m.id));
      remainingUsd = Math.max(0, m.budget.usd - (spent?.usd ?? 0));
    }
    const p = paramsOf(t);
    return routeLearned(
      {
        key: t.key,
        type: t.type,
        sensitivity: contract.sensitivity,
        pinnedAgentId,
        mode: single ? "single" : t.mode,
        hasTests: contract.acceptance.some((c) => c.hard && COMMAND_CHECKS.has(c.kind)),
        modeExplicit: single || t.mode !== "single" || p.explicit === true,
        modeParams: { ...(p.n ? { n: p.n } : {}), ...(p.steps ? { steps: p.steps } : {}) },
      },
      candidates,
      {
        priority: m.priority,
        rng: seeded(seedOf(`${t.id}:${t.revisions}`)),
        ...(remainingUsd !== undefined ? { remainingUsd } : {}),
        everyone: candidates,
      },
    );
  }

  private async emitRouted(m: Mission, t: Task, route: TaskRoute, agents: WorkspaceAgent[]) {
    const names = new Map(agents.map((a) => [a.id, a.name]));
    await this.emit(
      this.ctx.db,
      m,
      "task.routed",
      {
        taskKey: t.key,
        mode: route.mode,
        agents: route.agents.map((a) => ({ ...a, name: names.get(a.agentId) ?? a.agentId })),
        rationale: route.rationale,
        degraded: route.degraded ?? null,
        estUsd: route.estUsd,
      },
      { taskId: t.id },
    );
  }

  /** What a task's makers receive: handoff packets, the upstream branches to start from, and contract files. */
  private async taskInputs(m: Mission, t: Task, contract: TaskContract) {
    const packets = (await this.ctx.db.select().from(handoffs).where(eq(handoffs.toTaskId, t.id))).map(
      (h) => h.packet,
    );
    const contractFiles = await this.contractFiles(m, contract);
    const bases = isCodeTask(t) || t.type.startsWith("design.") ? await this.upstreamBranches(t) : [];
    return {
      packets,
      bases,
      files: [
        ...(packets.length ? [{ path: "handoff.json", content: JSON.stringify(packets, null, 2) }] : []),
        { path: "contract.json", content: JSON.stringify(contract, null, 2) },
        ...contractFiles,
      ],
    };
  }

  /**
   * The attempt that stands as the task's result: the one a multi-agent mode accepted, else the latest one (succeeded
   * only, when asked).
   */
  private async resultAttempt(t: Task, succeededOnly = true): Promise<Attempt | undefined> {
    const picked = paramsOf(t).result?.attemptId;
    if (picked) return (await this.ctx.db.select().from(attempts).where(eq(attempts.id, picked)))[0];
    if (!succeededOnly) return this.latestAttempt(t.id);
    const [a] = await this.ctx.db
      .select()
      .from(attempts)
      .where(and(eq(attempts.taskId, t.id), eq(attempts.status, "succeeded"), MADE))
      .orderBy(desc(attempts.endedAt))
      .limit(1);
    return a;
  }

  // ---- Multi-agent modes (ROUTING §3.2): the pure engine decides, this applies -------------------------------------

  private async modeStep(m: Mission, t: Task): Promise<void> {
    const route = paramsOf(t).route;
    if (!route || route.mode === "single") return;
    const rows = await this.ctx.db
      .select()
      .from(attempts)
      .where(and(eq(attempts.taskId, t.id), gte(attempts.createdAt, new Date(route.startedAt))))
      .orderBy(asc(attempts.createdAt));
    const state: ModeAttempt[] = [];
    for (const a of rows) {
      const mode = (a.dispatch as Dispatch | null)?.mode;
      // The verifier's agent checks are not part of the mode.
      if (!mode || mode.purpose === "check") continue;
      const item: ModeAttempt = {
        id: a.id,
        role: a.role,
        agentId: a.agentId,
        status: a.status,
        checks: "none",
        purpose: mode.purpose as ModeAttempt["purpose"],
        of: mode.of,
        step: mode.step,
        costUsd: a.costUsd ?? 0,
        createdAt: a.createdAt.getTime(),
      };
      if (a.status === "succeeded") {
        if (mode.purpose === "make" || mode.purpose === "revise" || mode.purpose === "merge")
          item.checks = await this.modeChecks(m, t, a);
        else if (mode.purpose === "judge") {
          const j = parseJudgment(await this.attemptOutput(a));
          if (j) item.winner = j.winner === "tie" ? "tie" : j.winner === "A" ? mode.of[0] : mode.of[1];
          await this.recordReview(m, t, a, mode.of, j ? { verdict: j.winner, reasons: j.reasons } : null);
        } else if (mode.purpose === "review") {
          const v = parseVerdict(await this.attemptOutput(a));
          // A review that cannot be read counts as no review at all.
          if (v) Object.assign(item, { verdict: v.verdict, reasons: v.reasons });
          else item.status = "failed";
          await this.recordReview(m, t, a, mode.of, v);
        }
      }
      state.push(item);
    }

    const actions = nextStep({
      mode: route.mode,
      agents: route.agents,
      attempts: state,
      maxRevisions: MAX_REVISIONS,
    });
    const byId = new Map(rows.map((a) => [a.id, a]));
    for (const action of actions) {
      if (action.kind === "dispatch") {
        const ok = await this.modeDispatch(m, t, route, action, byId);
        if (!ok) return;
      } else if (action.kind === "judged") {
        const w = byId.get(action.winner);
        const l = action.loser ? byId.get(action.loser) : undefined;
        const wk = w && attemptAgentKey(w.dispatch);
        const lk = l && attemptAgentKey(l.dispatch);
        if (wk && lk && (await this.markOnce(t.id, `elo:${action.winner}:${action.loser}`)))
          await this.scores.judgment(m.workspaceId, t.type, wk, lk, action.tie);
      } else if (action.kind === "accept") {
        return this.acceptModeResult(m, t, action.attemptId, action.note);
      } else {
        return this.failModeTask(m, t, action.reason);
      }
    }
  }

  /** A made result's hard checks, summarised for the engine. People's checks wait until a result is chosen. */
  private async modeChecks(m: Mission, t: Task, a: Attempt): Promise<ModeAttempt["checks"]> {
    const checks = (a.checks as AttemptChecks | null) ?? (await this.verifier.start(m, t, a, false));
    const auto = checks.items.filter((i) => i.hard && i.status !== "needs_human");
    if (auto.some((i) => i.status === "failed")) return "failed";
    if (auto.some((i) => i.status === "pending" || i.status === "running")) return "pending";
    return auto.length ? "passed" : "none";
  }

  /** Sets a once-per-task mark; true when this call set it. */
  private async markOnce(taskId: string, mark: string): Promise<boolean> {
    const [r] = await this.ctx.db
      .update(tasks)
      .set({
        modeParams: sql`jsonb_set(${tasks.modeParams}, '{marks}', coalesce(${tasks.modeParams}->'marks', '[]'::jsonb) || to_jsonb(${mark}::text))`,
      })
      .where(
        and(eq(tasks.id, taskId), sql`not (coalesce(${tasks.modeParams}->'marks', '[]'::jsonb) ? ${mark})`),
      )
      .returning({ id: tasks.id });
    return Boolean(r);
  }

  /** A checker's or judge's verdict, as a review row and an event (once). */
  private async recordReview(
    m: Mission,
    t: Task,
    reviewer: Attempt,
    of: string[],
    v: { verdict: "pass" | "revise" | "fail" | "A" | "B" | "tie"; reasons: string } | null,
  ) {
    if (!(await this.markOnce(t.id, `review:${reviewer.id}`))) return;
    const judging = of.length === 2;
    const reviewed = judging ? (v?.verdict === "B" ? of[1] : of[0]) : of[0];
    const verdict = judging
      ? v && v.verdict !== "tie"
        ? "pass"
        : "revise"
      : ((v?.verdict ?? "revise") as "pass" | "revise" | "fail");
    await this.ctx.db.insert(schema.reviews).values({
      workspaceId: m.workspaceId,
      taskId: t.id,
      attemptId: reviewed ?? null,
      reviewerAgentId: reviewer.agentId,
      kind: judging ? "judge" : "review",
      verdict,
      reasons: v?.reasons ?? "the answer could not be read",
      evidence: [{ reviewerAttemptId: reviewer.id, of }],
    });
    await this.emit(
      this.ctx.db,
      m,
      judging ? "judge.verdict" : "review.verdict",
      judging
        ? {
            taskKey: t.key,
            a: of[0],
            b: of[1],
            winner: v?.verdict ?? null,
            reasons: v?.reasons ?? "unreadable",
          }
        : {
            taskKey: t.key,
            verdict: v?.verdict ?? null,
            reasons: v ? [v.reasons] : ["unreadable review"],
            by: "agent",
          },
      { taskId: t.id, attemptId: reviewer.id },
    );
  }

  /** A result's text for reviewers, judges and mergers: the agent's report and its diff. */
  private async resultText(a: Attempt | undefined): Promise<string> {
    if (!a) return "";
    const rows = await this.ctx.db
      .select({ kind: artifacts.kind, bytes: blobs.bytes })
      .from(artifacts)
      .innerJoin(blobs, and(eq(blobs.workspaceId, artifacts.workspaceId), eq(blobs.sha256, artifacts.sha256)))
      .where(and(eq(artifacts.attemptId, a.id), inArray(artifacts.kind, ["report", "diff"])));
    const report = rows.find((r) => r.kind === "report")?.bytes.toString("utf8") ?? "";
    const diff = rows.find((r) => r.kind === "diff")?.bytes.toString("utf8") ?? "";
    return diff ? `${report}\n\n--- diff ---\n${diff}` : report;
  }

  private async modeDispatch(
    m: Mission,
    t: Task,
    route: TaskRoute,
    action: Extract<ModeAction, { kind: "dispatch" }>,
    byId: Map<string, Attempt>,
  ): Promise<boolean> {
    const contract = TaskContract.parse(t.contract);
    const brief = { title: t.title, objective: contract.objective, constraints: contract.constraints };
    const inputs = await this.taskInputs(m, t, contract);
    const sources = action.of.map((id) => byId.get(id));
    const texts = await Promise.all(sources.map((a) => this.resultText(a)));
    const branches = sources.flatMap((a) => (a?.worktreeRef ? [a.worktreeRef] : []));
    let instructions: string | undefined;
    let feedback = action.feedback;
    let bases = inputs.bases;
    let reader = false;
    switch (action.purpose) {
      case "review":
        instructions = reviewInstructions(brief, texts[0] ?? "");
        reader = true;
        break;
      case "judge":
        instructions = judgeInstructions(brief, texts[0] ?? "", texts[1] ?? "");
        reader = true;
        break;
      case "merge":
        instructions = mergeInstructions(brief, texts, feedback);
        feedback = undefined;
        // Code is merged on top of the first (the judge's pick, in a debate).
        bases = [...bases, ...branches.slice(0, 1)];
        break;
      case "revise":
        bases = [...bases, ...branches.slice(0, 1)];
        break;
      case "make":
        if (action.of.length) {
          // A pipeline step builds on the step before; a cascade step sees what the cheaper agent tried.
          const label =
            route.mode === "pipeline" ? "The previous step's result" : "A cheaper agent's failed attempt";
          instructions = stepInstructions(
            [renderInstructions(t, contract, m.goal), feedback ?? ""].filter(Boolean).join("\n\n"),
            texts[0] ?? "",
            label,
          );
          feedback = undefined;
          if (route.mode === "pipeline") bases = [...bases, ...branches.slice(0, 1)];
        }
        break;
    }
    try {
      await this.ctx.attempts.start({
        workspaceId: m.workspaceId,
        taskId: t.id,
        agentId: action.agentId,
        actor: "system",
        role: action.role,
        mode: { purpose: action.purpose, of: action.of, step: action.step },
        rationale: `${route.mode.replaceAll("_", " ")}: ${action.purpose}${action.step ? ` (step ${action.step + 1})` : ""}`,
        ...(reader
          ? { sandboxTaskType: "review.result" }
          : { handoffs: inputs.packets, bases, files: inputs.files }),
        ...(instructions ? { instructions } : {}),
        ...(feedback ? { feedback } : {}),
      });
      return true;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      await this.failModeTask(m, t, `${action.purpose}: ${err.message}`);
      return false;
    }
  }

  private async acceptModeResult(m: Mission, t: Task, attemptId: string, note: string): Promise<void> {
    const [a] = await this.ctx.db.select().from(attempts).where(eq(attempts.id, attemptId));
    if (!a) return;
    const [art] = await this.ctx.db
      .select({ id: artifacts.id, kind: artifacts.kind })
      .from(artifacts)
      .where(and(eq(artifacts.attemptId, a.id), inArray(artifacts.kind, ["diff", "report"])))
      .orderBy(asc(artifacts.kind));
    const [claimed] = await this.ctx.db
      .update(tasks)
      .set({
        status: "verifying",
        modeParams: { ...paramsOf(t), result: { attemptId, note } },
        ...(art ? { resultArtifactId: art.id } : {}),
      })
      .where(and(eq(tasks.id, t.id), eq(tasks.status, "running")))
      .returning();
    if (!claimed) return;
    // People are asked once, for the chosen result only.
    await this.verifier.announceHuman(m, t, a, (a.checks as AttemptChecks | null)?.items ?? [], note);
    this.schedule(m.id);
  }

  private async failModeTask(m: Mission, t: Task, reason: string): Promise<void> {
    const [f] = await this.ctx.db
      .update(tasks)
      .set({
        status: "failed",
        revisions: MAX_REVISIONS,
        blockedReason: reason,
        modeParams: { ...paramsOf(t), final: true },
      })
      .where(and(eq(tasks.id, t.id), eq(tasks.status, "running")))
      .returning();
    if (!f) return;
    await this.scoreAttempts(f, null);
    await this.emit(
      this.ctx.db,
      m,
      "review.verdict",
      { taskKey: t.key, verdict: "fail", reasons: [reason] },
      { taskId: t.id },
    );
    await this.releaseLeases(m, t, "task failed");
    await this.emit(this.ctx.db, m, "task.failed", { taskKey: t.key, reasons: [reason] }, { taskId: t.id });
  }

  /**
   * Scoreboard outcomes for a finished task's made results (each counted once): the accepted one passes; in modes the
   * others pass or fail on their own checks, and a result the checker sent back counts as a revise.
   */
  private async scoreAttempts(t: Task, acceptedId: string | null): Promise<void> {
    if (acceptedId) await this.scores.outcome(acceptedId, "pass", t.type);
    const route = paramsOf(t).route;
    if (!route || route.mode === "single") return;
    const rows = await this.ctx.db
      .select()
      .from(attempts)
      .where(and(eq(attempts.taskId, t.id), gte(attempts.createdAt, new Date(route.startedAt))));
    const revised = new Set(
      rows.flatMap((a) => {
        const mode = (a.dispatch as Dispatch | null)?.mode;
        return mode?.purpose === "revise" ? mode.of : [];
      }),
    );
    for (const a of rows) {
      const purpose = (a.dispatch as Dispatch | null)?.mode?.purpose;
      if (a.scored || (purpose !== "make" && purpose !== "revise")) continue;
      const checks =
        (a.checks as AttemptChecks | null)?.items.filter((i) => i.hard && i.status !== "needs_human") ?? [];
      const passed = a.status === "succeeded" && !checks.some((i) => i.status !== "passed");
      await this.scores.outcome(a.id, revised.has(a.id) ? "revise" : passed ? "pass" : "fail", t.type);
    }
  }

  private async blockTask(m: Mission, t: Task, reason: string) {
    const [b] = await this.ctx.db
      .update(tasks)
      .set({ status: "blocked", blockedReason: reason })
      .where(and(eq(tasks.id, t.id), ne(tasks.status, "blocked")))
      .returning();
    if (b) await this.emit(this.ctx.db, m, "task.blocked", { taskKey: t.key, reason }, { taskId: t.id });
  }

  /**
   * Exclusive leases on the task's footprint, granted under a per-workspace lock so two dispatches can never hold
   * overlapping files. Returns the resources granted, [] when the task already holds them, or null when another task
   * got there first.
   */
  private async acquireLeases(m: Mission, t: Task): Promise<string[] | null> {
    const footprint = footprintOf(t);
    const resources = footprint.length ? footprint : ["**"];
    return this.ctx.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`brio-leases:${m.workspaceId}`}, 0))`,
      );
      const active = await tx
        .select()
        .from(leases)
        .where(
          and(
            eq(leases.workspaceId, m.workspaceId),
            isNull(leases.releasedAt),
            gt(leases.expiresAt, new Date()),
          ),
        );
      if (active.some((l) => l.taskId === t.id)) return [];
      const { footprintsOverlap } = await import("@brio/core");
      if (active.some((l) => footprintsOverlap(resources, [l.resource]))) return null;
      const expiresAt = new Date(Date.now() + LEASE_TTL_MS);
      await tx.insert(leases).values(
        resources.map((r) => ({
          workspaceId: m.workspaceId,
          taskId: t.id,
          resourceKind: /[*?[{]/.test(r) ? ("glob" as const) : ("path" as const),
          resource: r,
          mode: "exclusive" as const,
          expiresAt,
        })),
      );
      await this.emit(
        tx,
        m,
        "lease.granted",
        { taskKey: t.key, resources, expiresAt: expiresAt.toISOString() },
        { taskId: t.id },
      );
      return resources;
    });
  }

  private async releaseLeases(m: Mission, t: Pick<Task, "id" | "key">, why: string) {
    const released = await this.ctx.db
      .update(leases)
      .set({ releasedAt: new Date() })
      .where(and(eq(leases.taskId, t.id), isNull(leases.releasedAt)))
      .returning({ resource: leases.resource });
    if (released.length)
      await this.emit(
        this.ctx.db,
        m,
        "lease.released",
        { taskKey: t.key, resources: released.map((r) => r.resource), why },
        { taskId: t.id },
      );
  }

  private async releaseMissionLeases(m: Mission) {
    const open = await this.ctx.db
      .select({ id: tasks.id, key: tasks.key })
      .from(tasks)
      .innerJoin(leases, eq(leases.taskId, tasks.id))
      .where(and(eq(tasks.missionId, m.id), isNull(leases.releasedAt)));
    for (const t of new Map(open.map((o) => [o.id, o])).values())
      await this.releaseLeases(m, t, "mission ended");
  }

  /** Branches of the direct upstream tasks' accepted attempts, so this task starts from their changes. */
  private async upstreamBranches(t: Task): Promise<string[]> {
    if (!t.dependsOn.length) return [];
    const ups = await this.ctx.db.select().from(tasks).where(inArray(tasks.id, t.dependsOn));
    const out: string[] = [];
    for (const u of ups) {
      if (u.status !== "done") continue;
      const a = await this.resultAttempt(u);
      if (a?.worktreeRef && (await this.hasDiff(u))) out.push(a.worktreeRef);
    }
    return out;
  }

  private async hasDiff(t: Task): Promise<boolean> {
    if (!t.resultArtifactId) return false;
    const [a] = await this.ctx.db
      .select({ kind: artifacts.kind })
      .from(artifacts)
      .where(eq(artifacts.id, t.resultArtifactId));
    return a?.kind === "diff";
  }

  /** The contracts a task consumes, as files in .brio/contracts/. */
  private async contractFiles(m: Mission, contract: TaskContract) {
    const names = contract.inputs.filter((i) => i.kind === "contract").map((i) => i.ref);
    if (!names.length) return [];
    const rows = await this.ctx.db
      .select()
      .from(contracts)
      .where(
        and(eq(contracts.missionId, m.id), inArray(contracts.name, names), eq(contracts.status, "active")),
      );
    return rows.map((c) => ({
      path: `contracts/${c.name}.md`,
      content: `# ${c.name} v${c.version}\n\n${typeof c.spec === "string" ? c.spec : JSON.stringify(c.spec, null, 2)}`,
    }));
  }

  // ---- Verification (ROUTING §4): the verifier fills the checklist; the verdict logic decides ----------------------

  private async verify(m: Mission, t: Task): Promise<void> {
    const a = await this.resultAttempt(t);
    if (!a) return;
    if (!a.checks) await this.verifier.start(m, t, a);
    const checks = await this.verifier.advance(m, t, a);
    if (!checks) return;
    const p = paramsOf(t);
    const v = verdict({ items: checks.items, revisions: t.revisions, reroutes: p.reroutes ?? 0 });
    if (v.kind === "wait") return;
    if (v.kind === "pass") return this.completeTask(m, t, a, checks, v.softFailures);
    await this.verifier.cancelOpen(a);
    return this.sendBack(m, t, a, v.kind, v.reasons);
  }

  /**
   * revise: back to the same agent with the failures. reroute: to the next-best agent (the ones that failed are
   * excluded). fail: the task fails for good, and the planner is asked for a revised plan.
   */
  private async sendBack(
    m: Mission,
    t: Task,
    a: Attempt,
    kind: "revise" | "reroute" | "fail",
    reasons: string[],
  ) {
    const from = ["verifying", "failed", "revise"] as Task["status"][];
    if (kind === "revise") {
      const [r] = await this.ctx.db
        .update(tasks)
        .set({ status: "revise", revisions: t.revisions + 1 })
        .where(and(eq(tasks.id, t.id), inArray(tasks.status, from), eq(tasks.revisions, t.revisions)))
        .returning();
      if (!r) return;
      await this.scores.outcome(a.id, a.status === "succeeded" ? "revise" : "fail", t.type);
      await this.emit(
        this.ctx.db,
        m,
        "review.verdict",
        { taskKey: t.key, verdict: "revise", reasons, revision: r.revisions },
        { taskId: t.id, attemptId: a.id },
      );
      return;
    }
    if (kind === "reroute") {
      const tried = await this.ctx.db
        .select({ agentId: attempts.agentId, dispatch: attempts.dispatch })
        .from(attempts)
        .where(eq(attempts.taskId, t.id));
      const makers = [...new Set(tried.filter((x) => Verifier.purpose(x) !== "check").map((x) => x.agentId))];
      const p = paramsOf(t);
      const [r] = await this.ctx.db
        .update(tasks)
        .set({
          status: "revise",
          revisions: 0,
          pinnedAgentId: null,
          modeParams: { ...p, reroutes: (p.reroutes ?? 0) + 1, reroute: { exclude: makers, reasons } },
        })
        .where(and(eq(tasks.id, t.id), inArray(tasks.status, from), eq(tasks.revisions, t.revisions)))
        .returning();
      if (!r) return;
      await this.scores.outcome(a.id, "fail", t.type);
      await this.emit(
        this.ctx.db,
        m,
        "review.verdict",
        { taskKey: t.key, verdict: "reroute", reasons, excluded: makers.length },
        { taskId: t.id, attemptId: a.id },
      );
      return;
    }
    const [f] = await this.ctx.db
      .update(tasks)
      .set({
        status: "failed",
        blockedReason: reasons.join("; ").slice(0, 2000),
        modeParams: { ...paramsOf(t), final: true },
      })
      .where(and(eq(tasks.id, t.id), inArray(tasks.status, from)))
      .returning();
    if (!f) return;
    await this.scores.outcome(a.id, "fail", t.type);
    await this.scoreAttempts(f, null);
    await this.emit(
      this.ctx.db,
      m,
      "review.verdict",
      { taskKey: t.key, verdict: "fail", reasons },
      { taskId: t.id, attemptId: a.id },
    );
    await this.releaseLeases(m, t, "task failed");
    await this.emit(this.ctx.db, m, "task.failed", { taskKey: t.key, reasons }, { taskId: t.id });
  }

  /** An attempt that failed outright (vendor error, limit) follows the same path as a failed check. */
  private async reviseAfterFailedAttempt(m: Mission, t: Task): Promise<void> {
    if (paramsOf(t).final) return;
    const a = await this.latestAttempt(t.id);
    if (!a || a.status === "running" || a.status === "queued") return;
    const v = verdict({
      items: [
        { kind: "attempt", hard: true, status: "failed", summary: a.exitReason ?? "the attempt failed" },
      ],
      revisions: t.revisions,
      reroutes: paramsOf(t).reroutes ?? 0,
    });
    if (v.kind === "revise" || v.kind === "reroute" || v.kind === "fail")
      await this.sendBack(m, t, a, v.kind, v.reasons);
  }

  /** A person's verdict on a task waiting for review (human checks, and M5 kinds until then). */
  async review(
    m: Mission,
    t: Task,
    verdict: "pass" | "revise" | "fail",
    reasons: string,
    userId: string,
  ): Promise<void> {
    const a = await this.resultAttempt(t);
    const checks = a?.checks as AttemptChecks | null;
    if (!a || !checks || t.status !== "verifying")
      throw new HttpError(409, "this task is not waiting for review", "not_reviewable");
    await this.ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from attempts where id = ${a.id} for update`);
      const items = checks.items.map((i) =>
        i.status === "needs_human"
          ? {
              ...i,
              status: verdict === "pass" ? ("passed" as const) : ("failed" as const),
              summary: reasons || verdict,
            }
          : i,
      );
      await tx
        .update(attempts)
        .set({ checks: { ...checks, items } as unknown as Record<string, unknown> })
        .where(eq(attempts.id, a.id));
      await tx.insert(schema.reviews).values({
        workspaceId: m.workspaceId,
        taskId: t.id,
        attemptId: a.id,
        reviewerUserId: userId,
        kind: "human",
        verdict,
        reasons,
      });
      const base = { taskId: t.id, attemptId: a.id, actor: `user:${userId}` as Actor };
      await this.emit(
        tx,
        m,
        "review.verdict",
        { taskKey: t.key, verdict, reasons: reasons ? [reasons] : [] },
        base,
      );
      await this.emit(
        tx,
        m,
        "approval.decided",
        { taskKey: t.key, decision: verdict === "pass" ? "approved" : "rejected" },
        base,
      );
      // A person's "fail" is final: no more revisions or other agents.
      if (verdict === "fail")
        await tx
          .update(tasks)
          .set({ revisions: MAX_REVISIONS, modeParams: { ...paramsOf(t), reroutes: MAX_REROUTES } })
          .where(eq(tasks.id, t.id));
    });
    this.schedule(m.id);
  }

  private async completeTask(
    m: Mission,
    t: Task,
    a: Attempt,
    checks: AttemptChecks,
    softFailures: string[] = [],
  ): Promise<void> {
    const [done] = await this.ctx.db
      .update(tasks)
      .set({ status: "done", blockedReason: null })
      .where(and(eq(tasks.id, t.id), eq(tasks.status, "verifying")))
      .returning();
    if (!done) return;
    await this.releaseLeases(m, t, "task done");
    await this.scoreAttempts(done, a.id);
    const output = await this.attemptOutput(a);
    const dispatch = a.dispatch as {
      agent?: { name: string; model: string; connector: { presetKey: string } };
    } | null;
    const agentKey = dispatch?.agent
      ? `${dispatch.agent.connector.presetKey}/${dispatch.agent.model}`
      : a.agentId;

    // A design task's output is a contract: register it (a new version supersedes the old) and tell running consumers.
    let contract: { name: string; version: string } | null = null;
    if (t.type.startsWith("design.")) contract = await this.registerContract(m, t, a, output);

    await this.handOff(m, t, a, checks, output, agentKey, dispatch?.agent?.connector.presetKey ?? "unknown");
    const cost = await this.ctx.db
      .select({ usd: sql<number>`coalesce(sum(${attempts.costUsd}), 0)::float` })
      .from(attempts)
      .where(eq(attempts.taskId, t.id));
    await this.emit(
      this.ctx.db,
      m,
      "task.done",
      {
        taskKey: t.key,
        attemptId: a.id,
        agent: agentKey,
        checks: checks.items.map((i) => ({ kind: i.kind, status: i.status })),
        costUsd: cost[0]?.usd ?? 0,
        contract,
        mode: paramsOf(t).route?.mode ?? "single",
        ...(softFailures.length ? { softFailures } : {}),
        ...(paramsOf(t).result ? { note: paramsOf(t).result?.note } : {}),
      },
      { taskId: t.id },
    );
  }

  /**
   * After a task failed for good (verdict: revise, reroute, fail), the planner proposes a revised plan once, when nothing
   * else is still working. Done tasks it keeps unchanged carry their work over (approvePlan). False: fail the mission.
   */
  private async proposeReplan(m: Mission, rows: Task[], reason: string): Promise<boolean> {
    const report = (m.report ?? {}) as { replans?: number };
    if ((report.replans ?? 0) >= MAX_REPLANS) return false;
    const failed = rows.find((t) => t.status === "failed");
    if (!failed) return false;
    // Let the rest of the plan settle first: its results are worth keeping.
    if (rows.some((t) => ["leased", "running", "verifying", "revise"].includes(t.status))) return true;
    if (!choosePlanner(await routeAgents(this.ctx, m.workspaceId), m.plannerAgentId).ok) return false;
    const plan = await latestApproved(this.ctx.db, m.id);
    if (!plan) return false;
    const doneKeys = new Set(rows.filter((t) => t.status === "done").map((t) => t.key));
    const replan = {
      failed: {
        key: failed.key,
        title: failed.title,
        reasons: (failed.blockedReason ?? reason).split("; ").filter(Boolean).slice(0, 10),
      },
      done: plan.graph.tasks.filter((t) => doneKeys.has(t.key)),
    };
    const claimed = await this.ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .update(missions)
        .set({
          status: "planning",
          blockedReason: null,
          report: { ...(m.report ?? {}), replans: (report.replans ?? 0) + 1, replan },
        })
        .where(and(eq(missions.id, m.id), eq(missions.status, "running")))
        .returning();
      if (!row) return false;
      await tx
        .update(tasks)
        .set({ status: "ready", revisions: 0, blockedReason: null })
        .where(and(eq(tasks.missionId, m.id), eq(tasks.planVersion, 0)));
      await this.emit(tx, m, "mission.replanning", {
        reason,
        failedTask: failed.key,
        reasons: replan.failed.reasons,
        keep: [...doneKeys],
      });
      return true;
    });
    if (claimed) {
      await this.releaseMissionLeases(m);
      this.schedule(m.id);
    }
    return true;
  }

  /** The handoffs (and a task.done) of a task carried over from an earlier plan version. */
  private async handOffCarried(m: Mission, t: Task): Promise<void> {
    const a = await this.resultAttempt(t);
    if (!a) return;
    const checks = (a.checks as AttemptChecks | null) ?? { requestedAt: new Date().toISOString(), items: [] };
    const d = a.dispatch as { agent?: { model: string; connector: { presetKey: string } } } | null;
    const agentKey = attemptAgentKey(a.dispatch) ?? a.agentId;
    await this.handOff(
      m,
      t,
      a,
      checks,
      await this.attemptOutput(a),
      agentKey,
      d?.agent?.connector.presetKey ?? "unknown",
    );
    await this.emit(
      this.ctx.db,
      m,
      "task.done",
      { taskKey: t.key, attemptId: a.id, agent: agentKey, carried: true, costUsd: 0, mode: "carried" },
      { taskId: t.id },
    );
  }

  /** A handoff packet from a finished task to each task that depends on it (in the same plan version). */
  private async handOff(
    m: Mission,
    t: Task,
    a: Attempt,
    checks: AttemptChecks,
    output: string,
    agentKey: string,
    vendor: string,
  ): Promise<void> {
    const downstream = await this.ctx.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.missionId, m.id),
          eq(tasks.planVersion, t.planVersion),
          sql`${t.id} = any(${tasks.dependsOn})`,
        ),
      );
    const artifactsOf = await this.ctx.db.select().from(artifacts).where(eq(artifacts.attemptId, a.id));
    // What it received (as the task it was carried over from, too): decisions keep flowing down the chain.
    const carriedFrom = paramsOf(t).carriedFrom;
    const received = await this.ctx.db
      .select({ packet: handoffs.packet })
      .from(handoffs)
      .where(inArray(handoffs.toTaskId, carriedFrom ? [t.id, carriedFrom] : [t.id]));
    const inheritedDecisions = received.flatMap((r) => r.packet.decisions);
    const activeContracts = await this.ctx.db
      .select()
      .from(contracts)
      .where(and(eq(contracts.missionId, m.id), eq(contracts.status, "active")));
    for (const d of downstream) {
      const packet: HandoffPacket = buildHandoff({
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        mission: { id: m.id, title: m.title, goal: m.goal },
        from: {
          taskKey: t.key,
          agentKey,
          vendor,
          summary: output.split(/\n\s*\n/)[0]?.slice(0, 600) ?? "",
          output,
        },
        to: { taskKey: d.key, objective: TaskContract.parse(d.contract).objective },
        artifacts: artifactsOf
          .filter((x) => x.kind === "diff" || x.kind === "report")
          .map((x) => ({ kind: x.kind, ref: `artifact:${x.id}`, sha256: x.sha256 })),
        contracts: activeContracts.map((c) => ({
          name: c.name,
          version: c.version,
          ref: `contract:${c.id}`,
        })),
        checks: checks.items
          .filter((i) => i.status === "passed" || i.status === "failed")
          .map((i) => ({
            kind: i.kind,
            passed: i.status === "passed",
            summary: i.summary ?? "",
            ref: `attempt:${a.id}#check-${i.index}`,
          })),
        constraints: TaskContract.parse(d.contract).constraints,
        inheritedDecisions,
      });
      const [h] = await this.ctx.db
        .insert(handoffs)
        .values({ workspaceId: m.workspaceId, fromTaskId: t.id, toTaskId: d.id, packet })
        .returning({ id: handoffs.id });
      await this.emit(
        this.ctx.db,
        m,
        "handoff.created",
        { from: t.key, to: d.key, handoffId: h?.id, decisions: packet.decisions.length },
        { taskId: d.id },
      );
    }
  }

  private async registerContract(m: Mission, t: Task, a: Attempt, output: string) {
    const files = await this.ctx.db
      .select({ meta: artifacts.meta, bytes: blobs.bytes })
      .from(artifacts)
      .innerJoin(blobs, and(eq(blobs.workspaceId, artifacts.workspaceId), eq(blobs.sha256, artifacts.sha256)))
      .where(and(eq(artifacts.attemptId, a.id), eq(artifacts.kind, "file")));
    const spec = files.length
      ? files
          .map((f) => `## ${(f.meta as { path?: string }).path ?? "file"}\n\n${f.bytes.toString("utf8")}`)
          .join("\n\n")
      : output;
    return this.ctx.db.transaction(async (tx) => {
      const [prev] = await tx
        .select()
        .from(contracts)
        .where(and(eq(contracts.missionId, m.id), eq(contracts.name, t.key)))
        .orderBy(desc(contracts.createdAt))
        .limit(1);
      const version = String(prev ? Number(prev.version) + 1 : 1);
      if (prev) await tx.update(contracts).set({ status: "superseded" }).where(eq(contracts.id, prev.id));
      await tx.insert(contracts).values({
        workspaceId: m.workspaceId,
        projectId: m.projectId,
        missionId: m.id,
        name: t.key,
        version,
        spec,
        ownerTaskId: t.id,
        status: "active",
      });
      if (prev) {
        await this.emit(
          tx,
          m,
          "contract.changed",
          { name: t.key, from: prev.version, to: version },
          { taskId: t.id },
        );
        // Consumers already working get a note: their contract moved under them.
        const consumers = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.missionId, m.id), inArray(tasks.status, ["running", "verifying", "revise"])));
        for (const c of consumers.filter((x) =>
          TaskContract.parse(x.contract).inputs.some((i) => i.kind === "contract" && i.ref === t.key),
        ))
          await tx.insert(schema.messages).values({
            workspaceId: m.workspaceId,
            missionId: m.id,
            toTaskId: c.id,
            kind: "note",
            body: `Contract ${t.key} changed to v${version}. Read it again with get_contract before you finish.`,
          });
      }
      return { name: t.key, version };
    });
  }

  private async finishMission(m: Mission): Promise<void> {
    const [done] = await this.ctx.db
      .update(missions)
      .set({ status: "done", blockedReason: null })
      .where(and(eq(missions.id, m.id), eq(missions.status, "running")))
      .returning();
    if (!done) return;
    const totals = await this.ctx.db
      .select({
        usd: sql<number>`coalesce(sum(${attempts.costUsd}), 0)::float`,
        attempts: sql<number>`count(*)::int`,
      })
      .from(attempts)
      .innerJoin(tasks, eq(tasks.id, attempts.taskId))
      .where(eq(tasks.missionId, m.id));
    await this.releaseMissionLeases(m);
    await this.emit(this.ctx.db, m, "mission.done", {
      costUsd: totals[0]?.usd ?? 0,
      attempts: totals[0]?.attempts ?? 0,
      minutes: Math.round((Date.now() - m.createdAt.getTime()) / 6000) / 10,
    });
  }
}

async function latestApproved(db: DbOrTx, missionId: string) {
  const [p] = await db
    .select()
    .from(schema.plans)
    .where(and(eq(schema.plans.missionId, missionId), eq(schema.plans.status, "approved")))
    .orderBy(desc(schema.plans.version))
    .limit(1);
  return p;
}

function failedChecksFeedback(a: Attempt): string {
  const checks = a.checks as AttemptChecks | null;
  const failed = checks?.items.filter((i) => i.status === "failed") ?? [];
  if (!failed.length) return a.exitReason ?? "The previous attempt did not finish.";
  return failed
    .map(
      (f) =>
        `- ${f.kind}${f.command ? ` (\`${f.command}\`)` : ""} failed: ${f.summary ?? ""}${f.output ? `\n\`\`\`\n${f.output.slice(-1500)}\n\`\`\`` : ""}`,
    )
    .join("\n");
}
