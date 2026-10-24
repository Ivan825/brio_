// The scoreboard (ROUTING §3.1, §5) as the orchestrator uses it: read scores with decay applied and priors for new
// models, and record outcomes, judgements and ratings. Every attempt counts once.

import { createHash } from "node:crypto";
import {
  applyOutcome,
  applyRating,
  decay,
  eloUpdate,
  freshScore,
  inheritPrior,
  type Outcome,
  passRate,
  type Score,
} from "@brio/core";
import { type DbOrTx, schema } from "@brio/db";
import { and, desc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import type { AppContext } from "../context";

const { attempts, scoreContributors, scoreHistory, scores, workspaces } = schema;

/** Global numbers are used only once this many outcomes from this many workspaces stand behind them (D-14). */
export const GLOBAL_MIN_N = 20;
export const GLOBAL_MIN_CONTRIBUTORS = 3;

/** A workspace's choices about the global scoreboard (D-14): both off by default. */
export interface ScoreSharing {
  /** Add this workspace's outcomes, anonymised, to the global scoreboard. */
  share: boolean;
  /** Start agents this workspace has not seen yet from the global numbers. */
  useGlobal: boolean;
}

export async function scoreSharingOf(db: DbOrTx, workspaceId: string): Promise<ScoreSharing> {
  const [w] = await db
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const sc = (w?.settings.scores ?? {}) as Partial<ScoreSharing>;
  return { share: sc.share === true, useGlobal: sc.useGlobal === true };
}

type Row = typeof scores.$inferSelect;

const toScore = (r: Row): Score => ({
  alpha: r.alpha,
  beta: r.beta,
  elo: r.elo,
  avgCost: r.avgCost,
  latencyS: r.p50LatencyS,
  n: r.n,
  updatedAt: r.updatedAt,
});

/** The scoreboard key for the agent that made an attempt: CLIs by adapter, model APIs by preset. */
export function attemptAgentKey(dispatch: unknown): string | null {
  const d = dispatch as {
    route?: string;
    adapterKey?: string;
    agent?: { model: string; connector: { presetKey: string } };
  } | null;
  if (!d?.agent) return null;
  const preset = d.agent.connector.presetKey;
  return `${d.route === "api" && preset ? preset : d.adapterKey}/${d.agent.model}`;
}

export class Scoreboard {
  constructor(private readonly ctx: AppContext) {}

  /** Scores for these agents on a task type, decayed to now; unseen agents inherit their vendor's latest prior. */
  async get(
    workspaceId: string,
    agentKeys: string[],
    taskType: string,
    now = new Date(),
  ): Promise<Map<string, Score>> {
    const out = new Map<string, Score>();
    if (!agentKeys.length) return out;
    const rows = await this.ctx.db
      .select()
      .from(scores)
      .where(
        and(
          eq(scores.scope, "workspace"),
          eq(scores.workspaceId, workspaceId),
          eq(scores.taskType, taskType),
          inArray(scores.agentKey, agentKeys),
        ),
      );
    for (const r of rows) out.set(r.agentKey, decay(toScore(r), now));
    // Agents this workspace has not seen: the global numbers first, when it opted in and enough stand behind them.
    const unseen = agentKeys.filter((k) => !out.has(k));
    if (unseen.length && (await scoreSharingOf(this.ctx.db, workspaceId)).useGlobal)
      for (const [key, g] of await this.global(unseen, taskType)) out.set(key, inheritPrior(g, now));
    for (const key of agentKeys) {
      if (out.has(key)) continue;
      const vendor = key.slice(0, key.indexOf("/") + 1);
      const [prev] = vendor
        ? await this.ctx.db
            .select()
            .from(scores)
            .where(
              and(
                eq(scores.scope, "workspace"),
                eq(scores.workspaceId, workspaceId),
                eq(scores.taskType, taskType),
                like(scores.agentKey, `${vendor}%`),
              ),
            )
            .orderBy(desc(scores.updatedAt))
            .limit(1)
        : [];
      out.set(key, prev && prev.n > 0 ? inheritPrior(toScore(prev), now) : freshScore(now));
    }
    return out;
  }

  private async update(
    db: DbOrTx,
    workspaceId: string,
    agentKey: string,
    taskType: string,
    fn: (s: Score) => Score,
  ) {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`brio-score:${workspaceId}:${agentKey}:${taskType}`}, 0))`,
      );
      const [row] = await tx
        .select()
        .from(scores)
        .where(
          and(
            eq(scores.scope, "workspace"),
            eq(scores.workspaceId, workspaceId),
            eq(scores.agentKey, agentKey),
            eq(scores.taskType, taskType),
          ),
        );
      const prior = row
        ? toScore(row)
        : ((await this.get(workspaceId, [agentKey], taskType)).get(agentKey) ?? freshScore(new Date()));
      const next = fn(prior);
      const values = {
        alpha: next.alpha,
        beta: next.beta,
        elo: next.elo,
        avgCost: Math.round(next.avgCost * 1e6) / 1e6,
        p50LatencyS: next.latencyS,
        n: next.n,
        updatedAt: next.updatedAt,
      };
      if (row) await tx.update(scores).set(values).where(eq(scores.id, row.id));
      else await tx.insert(scores).values({ scope: "workspace", workspaceId, agentKey, taskType, ...values });
      await tx
        .insert(scoreHistory)
        .values({ workspaceId, agentKey, taskType, passRate: passRate(next), elo: next.elo, n: next.n });
    });
  }

  /** Global scores for these keys that enough workspaces stand behind (D-14). */
  async global(agentKeys: string[], taskType: string): Promise<Map<string, Score>> {
    const out = new Map<string, Score>();
    if (!agentKeys.length) return out;
    const rows = await this.ctx.db
      .select({
        s: scores,
        contributors: sql<number>`(select count(*)::int from ${scoreContributors} c where c.agent_key = ${scores.agentKey} and c.task_type = ${scores.taskType})`,
      })
      .from(scores)
      .where(
        and(eq(scores.scope, "global"), eq(scores.taskType, taskType), inArray(scores.agentKey, agentKeys)),
      );
    for (const r of rows)
      if (r.s.n >= GLOBAL_MIN_N && r.contributors >= GLOBAL_MIN_CONTRIBUTORS)
        out.set(r.s.agentKey, toScore(r.s));
    return out;
  }

  /** Adds an outcome to the global scoreboard, without anything that says whose it was. */
  private async contribute(workspaceId: string, agentKey: string, taskType: string, fn: (s: Score) => Score) {
    const contributor = createHash("sha256")
      .update(`${this.ctx.config.BETTER_AUTH_SECRET}:score-contributor:${workspaceId}`)
      .digest("hex");
    await this.ctx.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`brio-score:global:${agentKey}:${taskType}`}, 0))`,
      );
      const [row] = await tx
        .select()
        .from(scores)
        .where(
          and(
            eq(scores.scope, "global"),
            isNull(scores.workspaceId),
            eq(scores.agentKey, agentKey),
            eq(scores.taskType, taskType),
          ),
        );
      const next = fn(row ? toScore(row) : freshScore(new Date()));
      const values = {
        alpha: next.alpha,
        beta: next.beta,
        elo: next.elo,
        avgCost: Math.round(next.avgCost * 1e6) / 1e6,
        p50LatencyS: next.latencyS,
        n: next.n,
        updatedAt: next.updatedAt,
      };
      if (row) await tx.update(scores).set(values).where(eq(scores.id, row.id));
      else
        await tx.insert(scores).values({ scope: "global", workspaceId: null, agentKey, taskType, ...values });
      await tx.insert(scoreContributors).values({ agentKey, taskType, contributor }).onConflictDoNothing();
    });
  }

  /** Counts one attempt's verdict (once). */
  async outcome(attemptId: string, outcome: Outcome, taskType: string): Promise<boolean> {
    const [a] = await this.ctx.db
      .update(attempts)
      .set({ scored: outcome })
      .where(and(eq(attempts.id, attemptId), isNull(attempts.scored)))
      .returning();
    const key = a ? attemptAgentKey(a.dispatch) : null;
    if (!a || !key) return false;
    const seconds = a.startedAt && a.endedAt ? (a.endedAt.getTime() - a.startedAt.getTime()) / 1000 : 0;
    const apply = (s: Score) => applyOutcome(s, { outcome, costUsd: a.costUsd, seconds, now: new Date() });
    await this.update(this.ctx.db, a.workspaceId, key, taskType, apply);
    if ((await scoreSharingOf(this.ctx.db, a.workspaceId)).share)
      await this.contribute(a.workspaceId, key, taskType, apply).catch((err: Error) =>
        this.ctx.log.warn({ err: err.message }, "global score contribution failed"),
      );
    return true;
  }

  /** A pairwise judgement between two attempts' agents (both orders were judged; a disagreement is a tie). */
  async judgment(
    workspaceId: string,
    taskType: string,
    winnerKey: string,
    loserKey: string,
    tie: boolean,
  ): Promise<void> {
    if (winnerKey === loserKey) return;
    const now = new Date();
    const both = await this.get(workspaceId, [winnerKey, loserKey], taskType, now);
    const [w, l] = eloUpdate(
      both.get(winnerKey)?.elo ?? 1200,
      both.get(loserKey)?.elo ?? 1200,
      tie ? "tie" : "a",
    );
    await this.update(this.ctx.db, workspaceId, winnerKey, taskType, (s) => ({
      ...s,
      elo: w,
      updatedAt: now,
    }));
    await this.update(this.ctx.db, workspaceId, loserKey, taskType, (s) => ({
      ...s,
      elo: l,
      updatedAt: now,
    }));
  }

  async rating(workspaceId: string, agentKey: string, taskType: string, rating: 1 | -1): Promise<void> {
    await this.update(this.ctx.db, workspaceId, agentKey, taskType, (s) =>
      applyRating(s, rating, new Date()),
    );
  }
}
