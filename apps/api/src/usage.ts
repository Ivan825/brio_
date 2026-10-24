// Usage (M10, D-105): what a workspace spent and ran over a period — by day, agent, vendor and task type — read by
// people (GET /v1/usage, the Governance page) and sent to an operator's billing system by the billing hook.
import { type DbOrTx, schema } from "@brio/db";
import { and, eq, gte, lt, sql } from "drizzle-orm";

const { agents, attempts, connectors, missions, tasks } = schema;

export interface UsageReport {
  workspaceId: string;
  from: string;
  to: string;
  totals: {
    costUsd: number;
    attempts: number;
    succeeded: number;
    failed: number;
    tokensIn: number;
    tokensOut: number;
    missionsDone: number;
    missionsFailed: number;
  };
  byDay: Array<{ day: string; costUsd: number; attempts: number }>;
  byAgent: Array<{
    agentId: string;
    name: string;
    model: string;
    costUsd: number;
    attempts: number;
    succeeded: number;
  }>;
  byVendor: Array<{ connector: string; costUsd: number; attempts: number }>;
  byTaskType: Array<{ taskType: string; costUsd: number; attempts: number; succeeded: number }>;
}

const usd = (n: unknown) => Math.round(Number(n ?? 0) * 1e6) / 1e6;
const int = (n: unknown) => Number(n ?? 0);

/** Attempts created in [from, to): what they cost, how they ended, who ran them. */
export async function usageReport(
  db: DbOrTx,
  workspaceId: string,
  from: Date,
  to: Date,
): Promise<UsageReport> {
  const inRange = and(
    eq(attempts.workspaceId, workspaceId),
    gte(attempts.createdAt, from),
    lt(attempts.createdAt, to),
  );
  const cost = sql<number>`coalesce(sum(${attempts.costUsd}), 0)::float`;
  const count = sql<number>`count(*)::int`;
  const succeeded = sql<number>`count(*) filter (where ${attempts.status} = 'succeeded')::int`;

  const [totals] = await db
    .select({
      costUsd: cost,
      attempts: count,
      succeeded,
      failed: sql<number>`count(*) filter (where ${attempts.status} in ('failed', 'timed_out'))::int`,
      tokensIn: sql<number>`coalesce(sum(${attempts.tokensIn}), 0)::bigint`,
      tokensOut: sql<number>`coalesce(sum(${attempts.tokensOut}), 0)::bigint`,
    })
    .from(attempts)
    .where(inRange);
  const [outcomes] = await db
    .select({
      done: sql<number>`count(*) filter (where ${missions.status} = 'done')::int`,
      failed: sql<number>`count(*) filter (where ${missions.status} = 'failed')::int`,
    })
    .from(missions)
    .where(
      and(eq(missions.workspaceId, workspaceId), gte(missions.updatedAt, from), lt(missions.updatedAt, to)),
    );

  const day = sql<string>`to_char(date_trunc('day', ${attempts.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
  const byDay = await db
    .select({ day, costUsd: cost, attempts: count })
    .from(attempts)
    .where(inRange)
    .groupBy(day)
    .orderBy(day);
  const byAgent = await db
    .select({
      agentId: agents.id,
      name: agents.name,
      model: agents.model,
      costUsd: cost,
      attempts: count,
      succeeded,
    })
    .from(attempts)
    .innerJoin(agents, eq(agents.id, attempts.agentId))
    .where(inRange)
    .groupBy(agents.id, agents.name, agents.model);
  const byVendor = await db
    .select({ connector: connectors.registryKey, costUsd: cost, attempts: count })
    .from(attempts)
    .innerJoin(agents, eq(agents.id, attempts.agentId))
    .innerJoin(connectors, eq(connectors.id, agents.connectorId))
    .where(inRange)
    .groupBy(connectors.registryKey);
  const byTaskType = await db
    .select({ taskType: tasks.type, costUsd: cost, attempts: count, succeeded })
    .from(attempts)
    .innerJoin(tasks, eq(tasks.id, attempts.taskId))
    .where(inRange)
    .groupBy(tasks.type);

  const byCost = <T extends { costUsd: number }>(rows: T[]) =>
    rows.map((r) => ({ ...r, costUsd: usd(r.costUsd) })).sort((a, b) => b.costUsd - a.costUsd);
  return {
    workspaceId,
    from: from.toISOString(),
    to: to.toISOString(),
    totals: {
      costUsd: usd(totals?.costUsd),
      attempts: int(totals?.attempts),
      succeeded: int(totals?.succeeded),
      failed: int(totals?.failed),
      tokensIn: int(totals?.tokensIn),
      tokensOut: int(totals?.tokensOut),
      missionsDone: int(outcomes?.done),
      missionsFailed: int(outcomes?.failed),
    },
    byDay: byDay.map((d) => ({ ...d, costUsd: usd(d.costUsd) })),
    byAgent: byCost(byAgent),
    byVendor: byCost(byVendor),
    byTaskType: byCost(byTaskType),
  };
}
