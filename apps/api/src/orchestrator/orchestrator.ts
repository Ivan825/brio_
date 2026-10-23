// The orchestrator loop (ARCHITECTURE §4.1, §4.2). It holds no state of its own: every tick reads the mission from the
// database, asks the pure scheduler what to do, and applies each action with a conditional update. So it can crash,
// run twice, or restart mid-mission, and the mission carries on from where the database says it is.
import { randomUUID } from "node:crypto";
import type { AttemptChecks, CheckItem } from "@brio/adapters";
import {
  buildHandoff,
  choosePlanner,
  decide,
  diffScope,
  LEASE_BLOCK,
  parsePlan,
  plannerInstructions,
  type SchedTask,
  staticRoute,
} from "@brio/core";
import { type DbOrTx, schema } from "@brio/db";
import { enqueueChecks } from "@brio/runner";
import { type Actor, type EventType, type HandoffPacket, TaskContract } from "@brio/schema";
import { and, asc, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { RUNNABLE_TASK } from "../attempts";
import type { AppContext } from "../context";
import { HttpError } from "../http";
import { routeAgents } from "./agents";
import { approvePlan, latestPlan, storePlan } from "./plans";

const { artifacts, attempts, blobs, contracts, handoffs, leases, missions, tasks } = schema;

type Mission = typeof missions.$inferSelect;
type Task = typeof tasks.$inferSelect;
type Attempt = typeof attempts.$inferSelect;

export const PLANNING_TASK_KEY = "brio.plan";
/** Revise loops per task before it fails (ARCHITECTURE §4.2). */
export const MAX_REVISIONS = 2;
/** Planner retries when its answer is not a valid plan. */
export const MAX_PLANNING_RETRIES = 2;
const MAX_PARALLEL = 4;
const LEASE_TTL_MS = 6 * 3600_000;
const COMMAND_CHECKS = new Set(["tests", "typecheck", "lint", "build"]);

const isCodeTask = (t: Pick<Task, "type">) => t.type.startsWith("code.") || t.type === "merge.integrate";
const footprintOf = (t: Task) => TaskContract.parse(t.contract).expectedFootprint?.paths ?? [];

export interface OrchestratorOptions {
  sweepMs?: number;
}

export class Orchestrator {
  private readonly busy = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private stopped = false;

  constructor(
    private readonly ctx: AppContext,
    private readonly opts: OrchestratorOptions = {},
  ) {}

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

  private async latestAttempt(taskId: string): Promise<Attempt | undefined> {
    const [a] = await this.ctx.db
      .select()
      .from(attempts)
      .where(eq(attempts.taskId, taskId))
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
            "planner",
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
    const notes = (m.report as { plannerNotes?: string[] } | null)?.plannerNotes;
    const instructions = plannerInstructions({
      goal: m.goal,
      repoFiles: [],
      repoAttached: repo,
      availableTaskTypes: [...new Set(agents.filter((a) => a.runnable).flatMap((a) => a.taskTypes))],
      ...(m.budget.usd !== undefined ? { budgetUsd: m.budget.usd } : {}),
      ...(feedback ? { feedback } : {}),
      ...(notes?.length ? { userNotes: notes } : {}),
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
    for (const t of rows)
      if (t.status === "failed" && t.revisions < MAX_REVISIONS) await this.reviseAfterFailedAttempt(m, t);

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
    const previous = revising ? await this.latestAttempt(fresh.id) : undefined;
    const agents = await routeAgents(this.ctx, m.workspaceId);
    const contract = TaskContract.parse(fresh.contract);
    const route = staticRoute(
      {
        key: fresh.key,
        type: fresh.type,
        sensitivity: contract.sensitivity,
        // A revision goes back to the agent that made the attempt.
        pinnedAgentId: previous?.agentId ?? fresh.pinnedAgentId,
        mode: fresh.mode,
      },
      agents,
    );
    if (!route.ok) {
      await this.blockTask(m, fresh, `route: ${route.reason}`);
      return;
    }

    const granted = isCodeTask(fresh) ? await this.acquireLeases(m, fresh) : [];
    if (granted === null) return; // lost a race for the files; the next tick blocks or retries it

    const packets = (await this.ctx.db.select().from(handoffs).where(eq(handoffs.toTaskId, fresh.id))).map(
      (h) => h.packet,
    );
    const contractFiles = await this.contractFiles(m, contract);
    const bases =
      isCodeTask(fresh) || fresh.type.startsWith("design.") ? await this.upstreamBranches(fresh) : [];
    try {
      await this.ctx.attempts.start({
        workspaceId: m.workspaceId,
        taskId: fresh.id,
        agentId: route.agentId,
        actor: "system",
        handoffs: packets,
        bases,
        files: [
          ...(packets.length ? [{ path: "handoff.json", content: JSON.stringify(packets, null, 2) }] : []),
          { path: "contract.json", content: JSON.stringify(contract, null, 2) },
          ...contractFiles,
        ],
        rationale: route.degraded ? `${route.rationale} · ${route.degraded}` : route.rationale,
        ...(revising && previous ? { feedback: failedChecksFeedback(previous) } : {}),
      });
    } catch (err) {
      if (granted.length) await this.releaseLeases(m, fresh, "dispatch failed");
      if (err instanceof HttpError) await this.blockTask(m, fresh, `dispatch: ${err.message}`);
      else throw err;
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
      const [a] = await this.ctx.db
        .select({ ref: attempts.worktreeRef })
        .from(attempts)
        .where(and(eq(attempts.taskId, u.id), eq(attempts.status, "succeeded")))
        .orderBy(desc(attempts.endedAt))
        .limit(1);
      if (a?.ref && (await this.hasDiff(u))) out.push(a.ref);
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

  // ---- Verification (the M3 verifier: command checks, diff scope, people; ROUTING §4 in full arrives in M5) ------

  private async verify(m: Mission, t: Task): Promise<void> {
    const [a] = await this.ctx.db
      .select()
      .from(attempts)
      .where(and(eq(attempts.taskId, t.id), eq(attempts.status, "succeeded")))
      .orderBy(desc(attempts.endedAt))
      .limit(1);
    if (!a) return;
    let checks = a.checks as AttemptChecks | null;
    if (!checks) checks = await this.startChecks(m, t, a);
    const hard = checks.items.filter((i) => i.hard);
    const failed = hard.filter((i) => i.status === "failed");
    if (failed.length) return this.sendBack(m, t, a, failed);
    if (hard.some((i) => i.status === "pending" || i.status === "running" || i.status === "needs_human"))
      return;
    return this.completeTask(m, t, a, checks);
  }

  private async startChecks(m: Mission, t: Task, a: Attempt): Promise<AttemptChecks> {
    const contract = TaskContract.parse(t.contract);
    const diff = (
      await this.ctx.db
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.attemptId, a.id), eq(artifacts.kind, "diff")))
    )[0];
    const changed = ((diff?.meta as { files?: { path: string }[] } | undefined)?.files ?? []).map(
      (f) => f.path,
    );
    const items: CheckItem[] = contract.acceptance.map((c, index) => {
      const base = { index, kind: c.kind, hard: c.hard, ...(c.command ? { command: c.command } : {}) };
      if (c.kind === "diff_scope") {
        const r = diffScope(changed, contract.expectedFootprint?.paths);
        return { ...base, status: r.passed ? "passed" : "failed", summary: r.summary };
      }
      if (COMMAND_CHECKS.has(c.kind))
        return a.worktreeRef
          ? { ...base, status: "pending" }
          : { ...base, status: "failed", summary: `${c.kind} needs files to check; this task produced none` };
      // Human checks, and the kinds the M5 verifier will run, wait for a person until then.
      return {
        ...base,
        status: "needs_human",
        summary:
          c.kind === "human"
            ? "waiting for a person"
            : `${c.kind} is reviewed by a person until the verifier (M5)`,
      };
    });
    const checks: AttemptChecks = { requestedAt: new Date().toISOString(), items };
    const [claimed] = await this.ctx.db
      .update(attempts)
      .set({ checks: checks as unknown as Record<string, unknown> })
      .where(and(eq(attempts.id, a.id), isNull(attempts.checks)))
      .returning();
    if (!claimed)
      return ((await this.ctx.db.select().from(attempts).where(eq(attempts.id, a.id)))[0]?.checks ??
        checks) as AttemptChecks;
    for (const i of items.filter((x) => x.status === "passed" || x.status === "failed"))
      await this.emit(
        this.ctx.db,
        m,
        "check.result",
        { index: i.index, kind: i.kind, passed: i.status === "passed", summary: i.summary ?? "" },
        { taskId: t.id, attemptId: a.id },
      );
    if (items.some((i) => i.status === "needs_human"))
      await this.emit(
        this.ctx.db,
        m,
        "approval.requested",
        {
          taskKey: t.key,
          what: "accept this task's result",
          checks: items.filter((i) => i.status === "needs_human").map((i) => i.kind),
        },
        { taskId: t.id, attemptId: a.id },
      );
    if (items.some((i) => i.status === "pending")) await enqueueChecks(this.ctx.queue, a.id);
    return checks;
  }

  /** Revise (same agent, with the failures) while revisions remain; otherwise the task fails. */
  private async sendBack(m: Mission, t: Task, a: Attempt, failed: CheckItem[]): Promise<void> {
    const reasons = failed.map((f) => `${f.kind}: ${f.summary ?? "failed"}`);
    if (t.revisions < MAX_REVISIONS) {
      const [r] = await this.ctx.db
        .update(tasks)
        .set({ status: "revise", revisions: t.revisions + 1 })
        .where(and(eq(tasks.id, t.id), eq(tasks.status, "verifying")))
        .returning();
      if (r)
        await this.emit(
          this.ctx.db,
          m,
          "review.verdict",
          { taskKey: t.key, verdict: "revise", reasons, revision: r.revisions },
          { taskId: t.id, attemptId: a.id },
        );
      return;
    }
    const [f] = await this.ctx.db
      .update(tasks)
      .set({ status: "failed", blockedReason: reasons.join("; ") })
      .where(and(eq(tasks.id, t.id), eq(tasks.status, "verifying")))
      .returning();
    if (f) {
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
  }

  /** An attempt that failed outright (vendor error, limit) gets the same revise budget as a failed check. */
  private async reviseAfterFailedAttempt(m: Mission, t: Task): Promise<void> {
    const a = await this.latestAttempt(t.id);
    if (!a || a.status === "running" || a.status === "queued") return;
    const [r] = await this.ctx.db
      .update(tasks)
      .set({ status: "revise", revisions: t.revisions + 1 })
      .where(and(eq(tasks.id, t.id), eq(tasks.status, "failed"), eq(tasks.revisions, t.revisions)))
      .returning();
    if (r)
      await this.emit(
        this.ctx.db,
        m,
        "review.verdict",
        {
          taskKey: t.key,
          verdict: "revise",
          reasons: [a.exitReason ?? "the attempt failed"],
          revision: r.revisions,
        },
        { taskId: t.id, attemptId: a.id },
      );
  }

  /** A person's verdict on a task waiting for review (human checks, and M5 kinds until then). */
  async review(
    m: Mission,
    t: Task,
    verdict: "pass" | "revise" | "fail",
    reasons: string,
    userId: string,
  ): Promise<void> {
    const [a] = await this.ctx.db
      .select()
      .from(attempts)
      .where(and(eq(attempts.taskId, t.id), eq(attempts.status, "succeeded")))
      .orderBy(desc(attempts.endedAt))
      .limit(1);
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
      if (verdict === "fail")
        await tx.update(tasks).set({ revisions: MAX_REVISIONS }).where(eq(tasks.id, t.id));
    });
    this.schedule(m.id);
  }

  private async completeTask(m: Mission, t: Task, a: Attempt, checks: AttemptChecks): Promise<void> {
    const [done] = await this.ctx.db
      .update(tasks)
      .set({ status: "done", blockedReason: null })
      .where(and(eq(tasks.id, t.id), eq(tasks.status, "verifying")))
      .returning();
    if (!done) return;
    await this.releaseLeases(m, t, "task done");
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
    const received = await this.ctx.db
      .select({ packet: handoffs.packet })
      .from(handoffs)
      .where(eq(handoffs.toTaskId, t.id));
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
          vendor: dispatch?.agent?.connector.presetKey ?? "unknown",
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
      },
      { taskId: t.id },
    );
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
