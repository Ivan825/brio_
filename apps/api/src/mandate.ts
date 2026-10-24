// Mandate (D-07, SECURITY_GOVERNANCE §7): a workspace may hand spend authority to the owner's Mandate instance. Brio
// then asks the workspace's mandate before every paid attempt — for the attempt's cap, from the vendor that will bill
// it — and the attempt may spend no more than Mandate held. When the attempt ends Brio captures what it really cost
// (or voids the hold). A request a person must approve waits in Mandate's inbox; the task stays blocked until they
// decide. Mandate unreachable means no dispatch (fail closed). Only Mandate's agent API is used: a person creates,
// pauses and revokes the mandate in Mandate itself.

import type { FetchLike } from "@brio/adapters";
import type { DbOrTx } from "@brio/db";
import { schema } from "@brio/db";
import { and, eq, inArray, isNull, like, lt } from "drizzle-orm";
import type { AppContext } from "./context";
import { HttpError, one } from "./http";

const { attempts, mandateConnections, mandateHolds, tasks } = schema;

/** What Mandate's agent API reports about the mandate a token holds (GET /api/agent/mandate). */
export interface MandateView {
  mandateId: string;
  mandate?: { name?: string };
  status: string;
  currency: string;
  sandbox?: boolean;
  frozen?: boolean;
  remaining?: { today: number | null; total: number | null };
  pendingApprovals?: number;
}

export interface Authorization {
  decision: "approved" | "declined" | "pending";
  reason?: string;
  rule?: string;
  transactionId?: string | null;
  approvalId?: string | null;
  remedy?: { message?: string; retryAt?: string };
}

export class MandateError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Mandate's agent REST API, with one mandate's `mnd_` token. Amounts are minor units (cents). */
export class MandateClient {
  constructor(private readonly o: { baseUrl: string; token: string; fetch: FetchLike }) {}

  private async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.o.fetch(`${this.o.baseUrl.replace(/\/+$/, "")}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.o.token}`,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, json };
  }

  async mandate(): Promise<MandateView> {
    const r = await this.call("GET", "/api/agent/mandate");
    if (r.status !== 200 || !r.json)
      throw new MandateError(r.status, String(r.json?.error ?? r.json?.message ?? `HTTP ${r.status}`));
    return r.json as unknown as MandateView;
  }

  /** Asks for authority to spend; the same key with the same body is the same request (a retry, or its answer). */
  async authorize(
    key: string,
    body: { amount: number; merchant: string; purpose: string; category: string; currency: string },
  ): Promise<Authorization> {
    const r = await this.call("POST", "/api/agent/authorize", body, { "idempotency-key": key });
    if (r.json && (r.status === 200 || r.status === 202 || r.status === 403) && "decision" in r.json)
      return r.json as unknown as Authorization;
    throw new MandateError(r.status, String(r.json?.error ?? r.json?.message ?? `HTTP ${r.status}`));
  }

  async capture(transactionId: string, amount: number, note: string): Promise<void> {
    const r = await this.call("POST", "/api/agent/capture", { transactionId, amount, note });
    if (r.status !== 200) throw new MandateError(r.status, String(r.json?.error ?? `HTTP ${r.status}`));
  }

  async void(transactionId: string, reason: string): Promise<void> {
    const r = await this.call("POST", "/api/agent/void", { transactionId, reason });
    if (r.status !== 200) throw new MandateError(r.status, String(r.json?.error ?? `HTTP ${r.status}`));
  }
}

export async function mandateClientFor(
  ctx: AppContext,
  db: DbOrTx,
  workspaceId: string,
): Promise<{ client: MandateClient; currency: string } | null> {
  const [conn] = await db
    .select()
    .from(mandateConnections)
    .where(eq(mandateConnections.workspaceId, workspaceId));
  if (!conn) return null;
  const token = (await ctx.vault.reveal(db, workspaceId, conn.tokenRef)).reveal();
  return {
    client: new MandateClient({ baseUrl: conn.baseUrl, token, fetch: ctx.fetch }),
    currency: conn.currency,
  };
}

const CATEGORY = "ai.compute";
const toCents = (usd: number) => Math.max(1, Math.ceil(usd * 100 - 1e-9));
/** Reasons on a task Mandate blocked; the sweep looks for them. */
export const MANDATE_PENDING = "mandate: waiting for a yes in Mandate";
const reasonOf = (a: Authorization) => a.remedy?.message ?? a.reason ?? a.rule ?? "no reason given";

/**
 * Asks the workspace's mandate before an attempt (none connected: nothing to ask). Returns the hold the attempt may
 * spend, or throws: pending (a person must decide in Mandate), declined, or unreachable — the task is blocked with it.
 */
export async function authorizeSpend(
  ctx: AppContext,
  input: { workspaceId: string; taskId: string; maxCostUsd: number; merchant: string; purpose: string },
): Promise<{ holdId: string; capUsd: number } | null> {
  const m = await mandateClientFor(ctx, ctx.db, input.workspaceId);
  if (!m || input.maxCostUsd <= 0) return null;
  // An earlier request for this task: approved but not yet used, or still waiting — asked again exactly as before.
  const [earlier] = await ctx.db
    .select()
    .from(mandateHolds)
    .where(
      and(
        eq(mandateHolds.taskId, input.taskId),
        isNull(mandateHolds.attemptId),
        inArray(mandateHolds.status, ["held", "pending"]),
      ),
    );
  if (earlier?.status === "held") return { holdId: earlier.id, capUsd: earlier.amountCents / 100 };
  const hold =
    earlier ??
    one(
      await ctx.db
        .insert(mandateHolds)
        .values({
          workspaceId: input.workspaceId,
          taskId: input.taskId,
          requestKey: `brio:${input.taskId}:${Date.now()}`,
          amountCents: toCents(input.maxCostUsd),
          merchant: input.merchant.slice(0, 200),
          purpose: input.purpose.slice(0, 500),
          status: "pending",
        })
        .returning(),
      "mandate hold",
    );
  const answer = await ask(ctx, m, hold);
  if (answer.decision === "approved") return { holdId: hold.id, capUsd: hold.amountCents / 100 };
  if (answer.decision === "pending")
    throw new HttpError(402, `${MANDATE_PENDING} (${reasonOf(answer)})`, "mandate_pending");
  throw new HttpError(402, `mandate: declined — ${reasonOf(answer)}`, "mandate_declined");
}

/** Asks Mandate about one request and records the answer; unreachable is an error the task is blocked with. */
async function ask(
  ctx: AppContext,
  m: { client: MandateClient; currency: string },
  h: typeof mandateHolds.$inferSelect,
): Promise<Authorization> {
  let a: Authorization;
  try {
    a = await m.client.authorize(h.requestKey, {
      amount: h.amountCents,
      merchant: h.merchant,
      purpose: h.purpose,
      category: CATEGORY,
      currency: m.currency,
    });
  } catch (err) {
    throw new HttpError(503, `mandate: unreachable (${(err as Error).message})`, "mandate_unreachable");
  }
  await recordAnswer(ctx, h, a);
  return a;
}

async function recordAnswer(ctx: AppContext, h: typeof mandateHolds.$inferSelect, a: Authorization) {
  const status = a.decision === "approved" ? "held" : a.decision;
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(mandateHolds)
      .set({
        status,
        transactionId: a.transactionId ?? h.transactionId,
        approvalId: a.approvalId ?? h.approvalId,
        reason: reasonOf(a),
      })
      .where(eq(mandateHolds.id, h.id));
    if (status !== h.status && status !== "pending")
      await ctx.ledger.append(tx, {
        workspaceId: h.workspaceId,
        kind: "spend",
        payload: {
          mandate: {
            decision: a.decision,
            rule: a.rule ?? null,
            transactionId: a.transactionId ?? null,
            amountCents: h.amountCents,
            merchant: h.merchant,
          },
          taskId: h.taskId,
        },
      });
  });
}

/**
 * Settles holds when their attempts end, and keeps waiting requests moving: each sweep asks Mandate again about the
 * ones a person has not decided yet, and frees their task once one is approved.
 */
export class MandateSettler {
  private unsubscribe: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly ctx: AppContext,
    private readonly sweepMs = 30_000,
  ) {}

  start(): void {
    this.unsubscribe = this.ctx.feed.subscribeAll((_missionId, _seq, hint) => {
      const id = hint.attemptId;
      if (hint.type === "attempt.finished" && id) this.enqueue(() => this.settle(id));
    });
    this.timer = setInterval(() => this.enqueue(() => this.sweep()), this.sweepMs);
    this.timer.unref();
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
  }

  /** Waits for queued work (tests). */
  idle(): Promise<void> {
    return this.chain;
  }

  private enqueue(fn: () => Promise<void>) {
    this.chain = this.chain
      .then(fn)
      .catch((err: Error) => this.ctx.log.warn({ err: err.message }, "mandate"));
  }

  /** Captures what an ended attempt cost (no more than was held), or voids the hold when it cost nothing. */
  async settle(attemptId: string): Promise<void> {
    const [row] = await this.ctx.db
      .select({ h: mandateHolds, a: attempts })
      .from(mandateHolds)
      .innerJoin(attempts, eq(attempts.id, mandateHolds.attemptId))
      .where(and(eq(mandateHolds.attemptId, attemptId), eq(mandateHolds.status, "held")));
    if (!row || ["queued", "running"].includes(row.a.status) || !row.h.transactionId) return;
    const m = await mandateClientFor(this.ctx, this.ctx.db, row.h.workspaceId);
    if (!m) return;
    const cents = row.a.costUsd > 0 ? Math.min(row.h.amountCents, toCents(row.a.costUsd)) : 0;
    if (cents > 0) await m.client.capture(row.h.transactionId, cents, `Brio attempt ${attemptId}`);
    else await m.client.void(row.h.transactionId, "the attempt cost nothing");
    await this.ctx.db.transaction(async (tx) => {
      await tx
        .update(mandateHolds)
        .set({ status: cents > 0 ? "captured" : "voided", capturedCents: cents, settledAt: new Date() })
        .where(eq(mandateHolds.id, row.h.id));
      await this.ctx.ledger.append(tx, {
        workspaceId: row.h.workspaceId,
        kind: "spend",
        payload: {
          mandate: {
            settled: cents > 0 ? "captured" : "voided",
            transactionId: row.h.transactionId,
            heldCents: row.h.amountCents,
            capturedCents: cents,
            merchant: row.h.merchant,
          },
          attemptId,
          costUsd: row.a.costUsd,
        },
      });
    });
  }

  async sweep(): Promise<void> {
    const { db } = this.ctx;
    // Holds whose attempts ended while a settlement failed (Mandate was down): settle them now.
    const ended = await db
      .select({ attemptId: mandateHolds.attemptId })
      .from(mandateHolds)
      .innerJoin(attempts, eq(attempts.id, mandateHolds.attemptId))
      .where(
        and(
          eq(mandateHolds.status, "held"),
          inArray(attempts.status, ["succeeded", "failed", "cancelled", "timed_out"]),
        ),
      );
    for (const e of ended) if (e.attemptId) await this.settle(e.attemptId).catch(() => undefined);

    // Held for an attempt that never started (its dispatch failed after the hold): give the money back after an hour.
    const stale = await db
      .select()
      .from(mandateHolds)
      .where(
        and(
          eq(mandateHolds.status, "held"),
          isNull(mandateHolds.attemptId),
          lt(mandateHolds.updatedAt, new Date(Date.now() - 3_600_000)),
        ),
      );
    for (const h of stale) {
      const m = await mandateClientFor(this.ctx, db, h.workspaceId);
      if (!m || !h.transactionId) continue;
      await m.client
        .void(h.transactionId, "not used by Brio")
        .then(() =>
          db
            .update(mandateHolds)
            .set({ status: "voided", capturedCents: 0, settledAt: new Date() })
            .where(eq(mandateHolds.id, h.id)),
        )
        .catch(() => undefined);
    }

    // Requests waiting for a person: asked again exactly as before; approved frees the task, declined says why.
    const waiting = await db.select().from(mandateHolds).where(eq(mandateHolds.status, "pending"));
    for (const h of waiting) {
      const m = await mandateClientFor(this.ctx, db, h.workspaceId);
      if (!m) continue;
      const answer = await m.client
        .authorize(h.requestKey, {
          amount: h.amountCents,
          merchant: h.merchant,
          purpose: h.purpose,
          category: CATEGORY,
          currency: m.currency,
        })
        .catch(() => null);
      if (!answer || answer.decision === "pending") continue;
      await recordAnswer(this.ctx, h, answer);
      const [t] = await db
        .update(tasks)
        .set(
          answer.decision === "approved"
            ? { status: "ready", blockedReason: null }
            : { blockedReason: `dispatch: mandate: declined — ${reasonOf(answer)}` },
        )
        .where(
          and(
            eq(tasks.id, h.taskId),
            eq(tasks.status, "blocked"),
            like(tasks.blockedReason, "dispatch: mandate:%"),
          ),
        )
        .returning();
      if (t && answer.decision === "approved") this.ctx.orchestrator.schedule(t.missionId);
    }
  }
}
