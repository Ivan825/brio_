// The scoreboard (ROUTING §3.1, §5) as the orchestrator uses it: read scores with decay applied and priors for new
// models, and record outcomes, judgements and ratings. Every attempt counts once.
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

const { attempts, scoreHistory, scores } = schema;

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
    await this.update(this.ctx.db, a.workspaceId, key, taskType, (s) =>
      applyOutcome(s, { outcome, costUsd: a.costUsd, seconds, now: new Date() }),
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
