// The billing hook (D-105): Brio is bring-your-own-keys, so vendors bill people directly; an operator that hosts Brio
// for others charges for Brio itself. With BRIO_BILLING_WEBHOOK_URL set, the worker sends each workspace's usage for
// each finished UTC day — once — to the operator's billing system, signed like Brio's other webhooks.
//
//   POST <url>   content-type: application/json
//   brio-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>
//   idempotency-key: <workspaceId>:<day>
//   { "type": "brio.usage.daily", "id": "<workspaceId>:<day>", "day": "YYYY-MM-DD", "workspace": {…}, "usage": {…} }
//
// A day that fails is tried again each hour, up to a day's worth of tries.
import { createHmac } from "node:crypto";
import { schema } from "@brio/db";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { AppContext } from "./context";
import { usageReport } from "./usage";

const { attempts, usageReports, workspaces } = schema;

export const MAX_TRIES = 24;
/** How far back unsent days are still sent. */
const LOOKBACK_DAYS = 7;

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

export function billingSignature(secret: string, body: string, at = Math.floor(Date.now() / 1000)): string {
  return `t=${at},v1=${createHmac("sha256", secret).update(`${at}.${body}`).digest("hex")}`;
}

export class BillingReporter {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly everyMs = 3_600_000,
  ) {}

  get enabled(): boolean {
    return Boolean(this.ctx.config.BRIO_BILLING_WEBHOOK_URL && this.ctx.config.BRIO_BILLING_WEBHOOK_SECRET);
  }

  start(): void {
    if (!this.enabled) return;
    const tick = () => {
      this.running ??= this.run()
        .then(
          () => undefined,
          (err: Error) => this.ctx.log.warn({ err: err.message }, "billing hook failed"),
        )
        .finally(() => {
          this.running = null;
        });
    };
    this.timer = setInterval(tick, this.everyMs);
    this.timer.unref();
    setTimeout(tick, 60_000).unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  /** Sends every finished day (within the lookback) not yet sent for each workspace that used Brio that day. */
  async run(now = new Date()): Promise<{ sent: number; failed: number }> {
    const url = this.ctx.config.BRIO_BILLING_WEBHOOK_URL;
    const secret = this.ctx.config.BRIO_BILLING_WEBHOOK_SECRET;
    if (!url || !secret) return { sent: 0, failed: 0 };
    const today = new Date(`${dayOf(now)}T00:00:00.000Z`);
    let sent = 0;
    let failed = 0;
    for (let back = LOOKBACK_DAYS; back >= 1; back--) {
      const from = new Date(today.getTime() - back * 86_400_000);
      const to = new Date(from.getTime() + 86_400_000);
      const day = dayOf(from);
      const active = await this.ctx.db
        .selectDistinct({ workspaceId: attempts.workspaceId })
        .from(attempts)
        .where(and(gte(attempts.createdAt, from), lt(attempts.createdAt, to)));
      if (!active.length) continue;
      const done = await this.ctx.db
        .select({
          workspaceId: usageReports.workspaceId,
          status: usageReports.status,
          tries: usageReports.tries,
        })
        .from(usageReports)
        .where(
          and(
            eq(usageReports.day, day),
            inArray(
              usageReports.workspaceId,
              active.map((a) => a.workspaceId),
            ),
          ),
        );
      const state = new Map(done.map((d) => [d.workspaceId, d]));
      for (const { workspaceId } of active) {
        const prior = state.get(workspaceId);
        if (prior?.status === "sent" || (prior?.tries ?? 0) >= MAX_TRIES) continue;
        const [w] = await this.ctx.db
          .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId));
        const usage = await usageReport(this.ctx.db, workspaceId, from, to);
        const payload = {
          type: "brio.usage.daily",
          id: `${workspaceId}:${day}`,
          day,
          workspace: w ?? { id: workspaceId },
          usage,
        };
        const body = JSON.stringify(payload);
        let error: string | null = null;
        try {
          const res = await this.ctx.fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "brio-signature": billingSignature(secret, body),
              "idempotency-key": `${workspaceId}:${day}`,
            },
            body,
            signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) error = `HTTP ${res.status}`;
          await res.body?.cancel().catch(() => {});
        } catch (err) {
          error = (err as Error).message;
        }
        await this.ctx.db
          .insert(usageReports)
          .values({
            workspaceId,
            day,
            status: error ? "failed" : "sent",
            tries: 1,
            payload,
            lastError: error,
            sentAt: error ? null : new Date(),
          })
          .onConflictDoUpdate({
            target: [usageReports.workspaceId, usageReports.day],
            set: {
              status: error ? "failed" : "sent",
              tries: sql`${usageReports.tries} + 1`,
              payload,
              lastError: error,
              sentAt: error ? null : new Date(),
            },
          });
        if (error) failed++;
        else sent++;
      }
    }
    return { sent, failed };
  }
}
