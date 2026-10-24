// The runner process (ARCHITECTURE §2, §6): pulls attempt jobs, executes them with bounded concurrency, heartbeats
// while they run, cancels them on request within seconds, and reaps what other runners left behind.
import { randomBytes } from "node:crypto";
import { type AgentAdapter, type FetchLike, LimitExceeded, type Logger } from "@brio/adapters";
import { type Db, type EventWriter, schema } from "@brio/db";
import type { Ledger } from "@brio/governance";
import type { Redactor, Vault } from "@brio/vault";
import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import pg from "pg";
import type { PgBoss } from "pg-boss";
import { CheckExecutor } from "./checks";
import { DeliveryExecutor, type DeliveryJob } from "./deliver";
import { docker, removeByLabel } from "./docker";
import { AttemptExecutor } from "./executor";
import type { ImageSet } from "./images";
import { IntegrationExecutor, type IntegrationJob } from "./integrate";
import { MailboxMcpServer } from "./mailbox-mcp";
import {
  ATTEMPT_QUEUE,
  type AttemptJob,
  CANCEL_CHANNEL,
  CHECK_QUEUE,
  DELIVER_QUEUE,
  enqueueAttempt,
  INTEGRATE_QUEUE,
  JobPump,
} from "./queue";

const { attempts, tasks } = schema;

export interface RunnerOptions {
  db: Db;
  databaseUrl: string;
  boss: PgBoss;
  events: EventWriter;
  ledger: Ledger;
  vault: Vault;
  redactor: Redactor;
  fetch: FetchLike;
  log: Logger;
  dir: string;
  images: ImageSet;
  concurrency?: number;
  heartbeatMs?: number;
  /** A running attempt whose heartbeat is older than this is presumed lost. */
  staleAfterMs?: number;
  reapEveryMs?: number;
  proxyAllowPrivate?: boolean;
  runnerId?: string;
  resolveAdapter?: (key: string) => AgentAdapter | undefined;
  answerWaitMs?: number;
  /**
   * How sandbox proxies reach this runner's mailbox. By default the Docker host (`host.docker.internal`), which is
   * where a runner on the host listens; a runner in a container names itself and the Docker network it is on, and
   * each proxy joins that network too (the proxy still refuses every other private address).
   */
  hostAccess?: { mailboxHost: string; network?: string };
  /** Port for the mailbox MCP server (0: any free port). */
  mailboxPort?: number;
  /** The GitHub REST API pull requests are opened through (GitHub Enterprise Server: its /api/v3). */
  githubApiUrl?: string;
}

export class Runner {
  readonly id: string;
  private readonly executor: AttemptExecutor;
  private readonly checks: CheckExecutor;
  private readonly integrations: IntegrationExecutor;
  private readonly deliveries: DeliveryExecutor;
  private readonly mailboxServer = new MailboxMcpServer();
  private readonly running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private listener: pg.Client | null = null;
  private timers: NodeJS.Timeout[] = [];
  private pumps: Array<{ start(): void; stop(): Promise<void> }> = [];
  private stopped = false;

  constructor(private readonly o: RunnerOptions) {
    this.id = o.runnerId ?? `runner-${randomBytes(4).toString("hex")}`;
    this.executor = new AttemptExecutor({ ...o, runnerId: this.id, mailboxServer: this.mailboxServer });
    this.checks = new CheckExecutor({ ...o, runnerId: this.id });
    this.integrations = new IntegrationExecutor({ ...o, runnerId: this.id });
    this.deliveries = new DeliveryExecutor(o);
  }

  get active(): string[] {
    return [...this.running.keys()];
  }

  async start(): Promise<void> {
    await this.mailboxServer.start(this.o.mailboxPort ?? 0);
    const n = this.o.concurrency ?? 2;
    this.pumps = [
      new JobPump<AttemptJob>(this.o.boss, ATTEMPT_QUEUE, n, async (job) => {
        await this.run(job.data.attemptId);
      }),
      new JobPump<AttemptJob>(this.o.boss, CHECK_QUEUE, n, async (job) => {
        if (!this.stopped) await this.checks.run(job.data.attemptId, job.signal);
      }),
      new JobPump<IntegrationJob>(this.o.boss, INTEGRATE_QUEUE, 1, async (job) => {
        if (!this.stopped) await this.integrations.run(job.data, job.signal);
      }),
      new JobPump<DeliveryJob>(this.o.boss, DELIVER_QUEUE, 1, async (job) => {
        if (!this.stopped) await this.deliveries.run(job.data);
      }),
    ];
    for (const p of this.pumps) p.start();
    this.listener = new pg.Client({ connectionString: this.o.databaseUrl });
    this.listener.on("error", (err) => this.o.log.warn({ err: err.message }, "cancel listener error"));
    await this.listener.connect();
    this.listener.on("notification", (n) => {
      if (n.channel === CANCEL_CHANNEL && n.payload) void this.cancelWithReason(n.payload);
    });
    await this.listener.query(`LISTEN ${CANCEL_CHANNEL}`);
    this.timers.push(setInterval(() => void this.heartbeat(), this.o.heartbeatMs ?? 10_000));
    this.timers.push(setInterval(() => void this.reap(), this.o.reapEveryMs ?? 30_000));
    for (const t of this.timers) t.unref();
    this.o.log.info({ runner: this.id }, "runner started");
  }

  /** Runs one attempt if this runner wins the claim. Resolves when the attempt is recorded as finished. */
  async run(attemptId: string): Promise<void> {
    if (this.stopped) return;
    const attempt = await this.executor.claim(attemptId);
    if (!attempt) return;
    const abort = new AbortController();
    const done = this.executor
      .execute(attempt, abort)
      .catch((err) =>
        this.o.log.error({ err: (err as Error).message, attemptId }, "attempt execution failed"),
      )
      .finally(() => this.running.delete(attemptId));
    this.running.set(attemptId, { abort, done });
    // A cancel that arrived before the claim must still win.
    if (attempt.cancelRequestedAt) abort.abort();
    await done;
  }

  /** Stops a running attempt here; a budget reached ends it as limit_exceeded, anything else as cancelled. */
  cancelLocal(attemptId: string, reason?: string | null): boolean {
    const r = this.running.get(attemptId);
    if (!r) return false;
    r.abort.abort(reason?.startsWith("budget") ? new LimitExceeded(reason) : undefined);
    return true;
  }

  private async cancelWithReason(attemptId: string): Promise<void> {
    if (!this.running.has(attemptId)) return;
    const [row] = await this.o.db
      .select({ reason: attempts.cancelReason })
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .catch(() => []);
    this.cancelLocal(attemptId, row?.reason ?? null);
  }

  /** Signs of life for running attempts; also picks up cancels missed by LISTEN. */
  async heartbeat(): Promise<void> {
    const ids = this.active;
    if (!ids.length) return;
    try {
      const rows = await this.o.db
        .update(attempts)
        .set({ heartbeatAt: new Date() })
        .where(and(inArray(attempts.id, ids), eq(attempts.runnerId, this.id)))
        .returning({ id: attempts.id, cancel: attempts.cancelRequestedAt, reason: attempts.cancelReason });
      for (const r of rows) if (r.cancel) this.cancelLocal(r.id, r.reason);
    } catch (err) {
      this.o.log.warn({ err: (err as Error).message }, "heartbeat failed");
    }
  }

  /**
   * Attempts whose runner stopped heartbeating are failed with an event (their process is gone); attempts stuck in
   * the queue are enqueued again; this runner's containers with no live attempt are removed.
   */
  async reap(): Promise<{ lost: number; requeued: number }> {
    const staleBefore = new Date(Date.now() - (this.o.staleAfterMs ?? 60_000));
    let lost = 0;
    let requeued = 0;
    try {
      const dead = await this.o.db
        .select({ attempt: attempts, missionId: tasks.missionId })
        .from(attempts)
        .innerJoin(tasks, eq(tasks.id, attempts.taskId))
        .where(and(eq(attempts.status, "running"), lt(attempts.heartbeatAt, staleBefore)));
      for (const { attempt, missionId } of dead) {
        if (this.running.has(attempt.id)) continue;
        const reason = `failed: runner ${attempt.runnerId ?? "unknown"} stopped responding`;
        const claimed = await this.o.db.transaction(async (tx) => {
          const [row] = await tx
            .update(attempts)
            .set({ status: "failed", endedAt: new Date(), exitReason: reason })
            .where(
              and(
                eq(attempts.id, attempt.id),
                eq(attempts.status, "running"),
                lt(attempts.heartbeatAt, staleBefore),
              ),
            )
            .returning({ id: attempts.id });
          if (!row) return false;
          await tx
            .update(tasks)
            .set({ status: "failed" })
            .where(and(eq(tasks.id, attempt.taskId), eq(tasks.status, "running")));
          await this.o.events.append(tx, {
            workspaceId: attempt.workspaceId,
            missionId,
            taskId: attempt.taskId,
            attemptId: attempt.id,
            type: "attempt.finished",
            actor: "system",
            payload: { status: "failed", exitReason: reason },
          });
          return true;
        });
        if (claimed) {
          lost++;
          await removeByLabel(`brio.attempt=${attempt.id}`).catch(() => 0);
        }
      }

      const stuck = await this.o.db
        .select({ id: attempts.id })
        .from(attempts)
        .where(
          and(
            eq(attempts.status, "queued"),
            isNotNull(attempts.dispatch),
            // A local runner's attempts wait for it to connect; they never go to the cloud queue.
            sql`(${attempts.dispatch} -> 'target') is null`,
            lt(attempts.createdAt, new Date(Date.now() - 30_000)),
          ),
        );
      for (const s of stuck) {
        await enqueueAttempt(this.o.boss, s.id);
        requeued++;
      }

      const ours = await docker(
        ["ps", "-aq", "--filter", `label=brio.runner=${this.id}`, "--format", '{{.Label "brio.attempt"}}'],
        {
          allowFail: true,
        },
      );
      for (const attemptId of new Set(ours.stdout.split("\n").filter(Boolean)))
        if (!this.running.has(attemptId)) await removeByLabel(`brio.attempt=${attemptId}`);
    } catch (err) {
      this.o.log.warn({ err: (err as Error).message }, "reaper pass failed");
    }
    return { lost, requeued };
  }

  /** Stops taking work, cancels what is running and waits for it to be recorded. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    for (const r of this.running.values()) r.abort.abort();
    await Promise.all(this.pumps.map((p) => p.stop()));
    await Promise.all([...this.running.values()].map((r) => r.done));
    await this.listener?.end().catch(() => {});
    await this.mailboxServer.stop();
  }
}

/**
 * For the API: ask whichever runner holds the attempt to stop it. A reason starting with "budget" ends it as
 * limit_exceeded (a budget reached, M9); otherwise it is cancelled.
 */
export async function requestCancel(db: Db, attemptId: string, reason?: string): Promise<void> {
  await db
    .update(attempts)
    .set({ cancelRequestedAt: new Date(), ...(reason ? { cancelReason: reason.slice(0, 500) } : {}) })
    .where(eq(attempts.id, attemptId));
  await db.execute(sql`select pg_notify(${CANCEL_CHANNEL}, ${attemptId})`);
}
