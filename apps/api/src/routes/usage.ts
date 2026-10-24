// Usage analytics and the public status page (M10, D-105).
import { schema } from "@brio/db";
import { and, eq, isNull, lt, max, min, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { HttpError, requireMember, requireSession, workspaceFor } from "../http";
import { usageReport } from "../usage";

const { attempts } = schema;

const Range = z.object({
  days: z.coerce.number().int().min(1).max(366).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});

type Health = "operational" | "degraded" | "down";
const worst = (all: Health[]): Health =>
  all.includes("down") ? "down" : all.includes("degraded") ? "degraded" : "operational";

export async function usageRoutes(app: FastifyInstance, ctx: AppContext) {
  /** What the workspace spent and ran: totals, and by day, agent, vendor and task type (`?days=30`, or `from`/`to`). */
  app.get("/v1/usage", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s);
    const q = Range.parse(req.query);
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - (q.days ?? 30) * 86_400_000);
    if (from >= to) throw new HttpError(400, "from must be before to", "bad_range");
    if (to.getTime() - from.getTime() > 366 * 86_400_000)
      throw new HttpError(400, "at most a year at a time", "bad_range");
    return { usage: await usageReport(ctx.db, workspaceId, from, to) };
  });

  /**
   * Public status: whether each part of Brio is working, with nothing about any workspace — the API, the database,
   * live events, and whether work is being picked up and kept alive by runners.
   */
  app.get("/v1/status", async () => {
    const now = Date.now();
    const t0 = performance.now();
    const db = await ctx.db
      .execute(sql`select 1`)
      .then(() => performance.now() - t0)
      .catch(() => null);
    const local = sql`${attempts.dispatch} -> 'target' ->> 'kind' = 'local'`;
    const queue =
      db === null
        ? null
        : await ctx.db
            .select({ oldest: min(attempts.createdAt) })
            .from(attempts)
            .where(
              and(eq(attempts.status, "queued"), isNull(attempts.cancelRequestedAt), sql`not (${local})`),
            )
            .then((r) => r[0]?.oldest ?? null)
            .catch(() => null);
    const beats =
      db === null
        ? null
        : await ctx.db
            .select({ latest: max(attempts.heartbeatAt), stale: sql<number>`count(*)::int` })
            .from(attempts)
            .where(
              and(
                eq(attempts.status, "running"),
                lt(attempts.heartbeatAt, new Date(now - 90_000)),
                sql`not (${local})`,
              ),
            )
            .then((r) => r[0] ?? null)
            .catch(() => null);
    const waitingS = queue ? Math.round((now - queue.getTime()) / 1000) : 0;
    const components: Array<{ name: string; status: Health; note: string }> = [
      { name: "API", status: "operational", note: "answering" },
      {
        name: "Database",
        status: db === null ? "down" : db > 1000 ? "degraded" : "operational",
        note: db === null ? "unreachable" : `${Math.round(db)} ms`,
      },
      {
        name: "Live events",
        status: ctx.feed.listening ? "operational" : "degraded",
        note: ctx.feed.listening ? "streaming" : "reconnecting; boards catch up when it returns",
      },
      {
        name: "Runners",
        status: db === null ? "down" : waitingS > 300 || (beats?.stale ?? 0) > 0 ? "degraded" : "operational",
        note:
          db === null
            ? "unknown"
            : waitingS > 300
              ? `work has waited ${Math.round(waitingS / 60)} min for a runner`
              : (beats?.stale ?? 0) > 0
                ? "some running work has stopped reporting"
                : "taking work",
      },
    ];
    return {
      status: worst(components.map((c) => c.status)),
      checkedAt: new Date(now).toISOString(),
      components,
    };
  });
}
