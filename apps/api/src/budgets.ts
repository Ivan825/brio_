// Budgets at every scope (BUILD_PLAN M9, SECURITY_GOVERNANCE §5): the workspace's month, an agent's month, a mission,
// a task. Spend is the attempts' cost, live while they run. Before dispatch an attempt's estimate must fit what is left
// at every scope (and its own limit is capped there); while work runs, the budget guard warns at the soft threshold
// and, once a scope is spent, emits budget.stop and stops every running attempt in it as limit_exceeded.
import { type DbOrTx, schema } from "@brio/db";
import { requestCancel } from "@brio/runner";
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { AppContext } from "./context";

const { attempts, budgets, events, missions, tasks } = schema;

export type ScopeKind = "workspace" | "agent" | "mission" | "task";

export interface ScopeState {
  kind: ScopeKind;
  id: string;
  label: string;
  limitUsd: number;
  spentUsd: number;
  softPct: number;
  /** Workspace and agent budgets are monthly; this is the month (UTC) the spend is for. */
  period: string | null;
}

/** The calendar month (UTC) monthly budgets count in, e.g. "2026-10". */
export const monthOf = (d = new Date()) => d.toISOString().slice(0, 7);
const monthStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

const sum = (rows: Array<{ usd: number | null }>) => Number(rows[0]?.usd ?? 0);
const spentWhere = async (db: DbOrTx, where: ReturnType<typeof and>) =>
  sum(
    await db
      .select({ usd: sql<number>`coalesce(sum(${attempts.costUsd}), 0)::float` })
      .from(attempts)
      .innerJoin(tasks, eq(tasks.id, attempts.taskId))
      .where(where),
  );

/** Every scope with a limit that an attempt of this agent on this task counts against, with its spend now. */
export async function budgetScopes(
  db: DbOrTx,
  ids: { workspaceId: string; agentId: string; missionId: string; taskId: string },
): Promise<ScopeState[]> {
  const out: ScopeState[] = [];
  const month = monthOf();
  const rows = await db
    .select()
    .from(budgets)
    .where(
      and(
        eq(budgets.workspaceId, ids.workspaceId),
        sql`(${budgets.scopeKind} = 'workspace' and ${budgets.scopeId} = ${ids.workspaceId}) or (${budgets.scopeKind} = 'agent' and ${budgets.scopeId} = ${ids.agentId})`,
      ),
    );
  for (const b of rows) {
    if (b.limitUsd === null) continue;
    const since = gte(attempts.createdAt, monthStart());
    const spentUsd =
      b.scopeKind === "workspace"
        ? await spentWhere(db, and(eq(attempts.workspaceId, ids.workspaceId), since))
        : await spentWhere(db, and(eq(attempts.agentId, ids.agentId), since));
    out.push({
      kind: b.scopeKind as ScopeKind,
      id: b.scopeId,
      label: b.scopeKind === "workspace" ? "workspace's monthly" : "agent's monthly",
      limitUsd: Number(b.limitUsd),
      spentUsd,
      softPct: b.softPct,
      period: month,
    });
  }
  const [m] = await db
    .select({ budget: missions.budget })
    .from(missions)
    .where(eq(missions.id, ids.missionId));
  if (m?.budget.usd !== undefined)
    out.push({
      kind: "mission",
      id: ids.missionId,
      label: "mission's",
      limitUsd: m.budget.usd,
      spentUsd: await spentWhere(db, eq(tasks.missionId, ids.missionId)),
      softPct: 80,
      period: null,
    });
  const [t] = await db
    .select({ budget: tasks.budget, contract: tasks.contract })
    .from(tasks)
    .where(eq(tasks.id, ids.taskId));
  const taskUsd = t?.budget.usd ?? (t?.contract as { budget?: { usd?: number } } | undefined)?.budget?.usd;
  if (taskUsd !== undefined)
    out.push({
      kind: "task",
      id: ids.taskId,
      label: "task's",
      limitUsd: taskUsd,
      spentUsd: await spentWhere(db, eq(attempts.taskId, ids.taskId)),
      softPct: 80,
      period: null,
    });
  return out;
}

const fmt = (n: number) => `$${n < 1 ? n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : n.toFixed(2)}`;
export const stopReason = (s: ScopeState) =>
  `budget: the ${s.label} budget of ${fmt(s.limitUsd)} is spent (${fmt(s.spentUsd)})`;

/**
 * Before dispatch: the estimate must fit what is left at every scope. Returns the most the attempt may spend (the
 * least left anywhere), or the scope that has no room.
 */
export async function checkBudgets(
  db: DbOrTx,
  ids: { workspaceId: string; agentId: string; missionId: string; taskId: string },
  estimateUsd: number,
): Promise<{ ok: true; capUsd: number | null } | { ok: false; scope: ScopeState }> {
  const scopes = await budgetScopes(db, ids);
  let cap: number | null = null;
  for (const s of scopes) {
    const left = s.limitUsd - s.spentUsd;
    if (left <= 0 || estimateUsd > left) return { ok: false, scope: s };
    cap = cap === null ? left : Math.min(cap, left);
  }
  return { ok: true, capUsd: cap };
}

/** Running attempts that count against a scope. */
async function runningIn(db: DbOrTx, s: ScopeState): Promise<string[]> {
  const where =
    s.kind === "workspace"
      ? eq(attempts.workspaceId, s.id)
      : s.kind === "agent"
        ? eq(attempts.agentId, s.id)
        : s.kind === "mission"
          ? eq(tasks.missionId, s.id)
          : eq(attempts.taskId, s.id);
  const rows = await db
    .select({ id: attempts.id })
    .from(attempts)
    .innerJoin(tasks, eq(tasks.id, attempts.taskId))
    .where(and(where, inArray(attempts.status, ["queued", "running"]), isNull(attempts.cancelRequestedAt)));
  return rows.map((r) => r.id);
}

/**
 * The live half (SECURITY_GOVERNANCE §5): on every cost event, the attempt's scopes are re-read; past the soft
 * threshold a budget.warn, at the limit a budget.stop and every running attempt in the scope stopped as
 * limit_exceeded. Each warning and stop happens once per scope (per month for monthly budgets).
 */
export class BudgetGuard {
  private unsubscribe: (() => void) | null = null;
  /** Checks run one after another, so a scope never warns or stops twice; queued attempts are not queued again. */
  private chain: Promise<void> = Promise.resolve();
  private readonly queued = new Set<string>();

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    this.unsubscribe = this.ctx.feed.subscribeAll((_missionId, _seq, hint) => {
      if (hint.type !== "attempt.cost" || !hint.attemptId) return;
      const id = hint.attemptId;
      if (this.queued.has(id)) return;
      this.queued.add(id);
      this.chain = this.chain.then(() => {
        this.queued.delete(id);
        return this.check(id).catch((err: Error) =>
          this.ctx.log.warn({ err: err.message, attemptId: id }, "budget check failed"),
        );
      });
    });
  }

  stop(): void {
    this.unsubscribe?.();
  }

  /** Checks the scopes of one attempt now (also used by tests and after budgets change). */
  async check(attemptId: string): Promise<void> {
    const { db } = this.ctx;
    const [a] = await db
      .select({ a: attempts, missionId: tasks.missionId })
      .from(attempts)
      .innerJoin(tasks, eq(tasks.id, attempts.taskId))
      .where(eq(attempts.id, attemptId));
    if (!a) return;
    const ids = {
      workspaceId: a.a.workspaceId,
      agentId: a.a.agentId,
      missionId: a.missionId,
      taskId: a.a.taskId,
    };
    for (const s of await budgetScopes(db, ids)) {
      const payload = {
        scope: s.kind,
        scopeId: s.id,
        limitUsd: s.limitUsd,
        spentUsd: Math.round(s.spentUsd * 1e6) / 1e6,
        ...(s.period ? { period: s.period } : {}),
      };
      // Past the soft threshold, once (also when one step jumps straight past the limit, so the warning is never lost).
      if (s.spentUsd >= (s.limitUsd * s.softPct) / 100 && (await this.once(s, "warn", ids.missionId)))
        await this.ctx.events.append(db, {
          workspaceId: ids.workspaceId,
          missionId: ids.missionId,
          type: "budget.warn",
          actor: "system",
          payload: { ...payload, softPct: s.softPct },
        });
      if (s.spentUsd >= s.limitUsd) {
        if (await this.once(s, "stop", ids.missionId))
          await this.ctx.events.append(db, {
            workspaceId: ids.workspaceId,
            missionId: ids.missionId,
            type: "budget.stop",
            actor: "system",
            payload: { ...payload, reason: stopReason(s) },
          });
        for (const id of await runningIn(db, s)) await requestCancel(db, id, stopReason(s));
      }
    }
  }

  /** True the first time a scope warns or stops (per month for monthly budgets). */
  private async once(s: ScopeState, what: "warn" | "stop", missionId: string): Promise<boolean> {
    const { db } = this.ctx;
    if (s.kind === "workspace" || s.kind === "agent") {
      const col = what === "warn" ? budgets.warnedPeriod : budgets.stoppedPeriod;
      const [row] = await db
        .update(budgets)
        .set(what === "warn" ? { warnedPeriod: s.period } : { stoppedPeriod: s.period })
        .where(
          and(
            eq(budgets.scopeKind, s.kind),
            eq(budgets.scopeId, s.id),
            sql`${col} is distinct from ${s.period}`,
          ),
        )
        .returning({ id: budgets.id });
      return Boolean(row);
    }
    const [seen] = await db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.missionId, missionId),
          eq(events.type, what === "warn" ? "budget.warn" : "budget.stop"),
          sql`${events.payload} ->> 'scope' = ${s.kind} and ${events.payload} ->> 'scopeId' = ${s.id}`,
        ),
      )
      .limit(1);
    return !seen;
  }
}
