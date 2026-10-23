// The runner process (ARCHITECTURE §2, §6): pulls attempt jobs, executes them with bounded concurrency, heartbeats
// while they run, cancels them on request within seconds, and reaps what other runners left behind.
import { randomBytes } from "node:crypto";
import type { AgentAdapter, FetchLike, Logger } from "@brio/adapters";
import { type Db, type EventWriter, schema } from "@brio/db";
import type { Ledger } from "@brio/governance";
import type { Redactor, Vault } from "@brio/vault";
import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import pg from "pg";
import type { PgBoss } from "pg-boss";
import { CheckExecutor } from "./checks";
import { docker, removeByLabel } from "./docker";
import { AttemptExecutor } from "./executor";
import type { ImageSet } from "./images";
import { MailboxMcpServer } from "./mailbox-mcp";
import { ATTEMPT_QUEUE, type AttemptJob, CANCEL_CHANNEL, CHECK_QUEUE, enqueueAttempt } from "./queue";

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
  /** Port for the mailbox MCP server (0: any free port). */
  mailboxPort?: number;
}

export class Runner {
  readonly id: string;
  private readonly executor: AttemptExecutor;
  private readonly checks: CheckExecutor;
  private readonly mailboxServer = new MailboxMcpServer();
  private readonly running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private listener: pg.Client | null = null;
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;

  constructor(private readonly o: RunnerOptions) {
    this.id = o.runnerId ?? `runner-${randomBytes(4).toString("hex")}`;
    this.executor = new AttemptExecutor({ ...o, runnerId: this.id, mailboxServer: this.mailboxServer });
    this.checks = new CheckExecutor({ ...o, runnerId: this.id });
  }

  get active(): string[] {
    return [...this.running.keys()];
  }

  async start(): Promise<void> {
    await this.mailboxServer.start(this.o.mailboxPort ?? 0);
    await this.o.boss.work<AttemptJob>(
      ATTEMPT_QUEUE,
      { localConcurrency: this.o.concurrency ?? 2, batchSize: 1, pollingIntervalSeconds: 0.5 },
      async ([job]) => {
        if (job) await this.run(job.data.attemptId);
      },
    );
    await this.o.boss.work<AttemptJob>(
      CHECK_QUEUE,
      { localConcurrency: this.o.concurrency ?? 2, batchSize: 1, pollingIntervalSeconds: 0.5 },
      async ([job]) => {
        if (job && !this.stopped) await this.checks.run(job.data.attemptId, job.signal);
      },
    );
    this.listener = new pg.Client({ connectionString: this.o.databaseUrl });
    this.listener.on("error", (err) => this.o.log.warn({ err: err.message }, "cancel listener error"));
    await this.listener.connect();
    this.listener.on("notification", (n) => {
      if (n.channel === CANCEL_CHANNEL && n.payload) this.cancelLocal(n.payload);
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

  cancelLocal(attemptId: string): boolean {
    const r = this.running.get(attemptId);
    if (!r) return false;
    r.abort.abort();
    return true;
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
        .returning({ id: attempts.id, cancel: attempts.cancelRequestedAt });
      for (const r of rows) if (r.cancel) this.cancelLocal(r.id);
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
    await this.o.boss.offWork(ATTEMPT_QUEUE).catch(() => {});
    await this.o.boss.offWork(CHECK_QUEUE).catch(() => {});
    for (const r of this.running.values()) r.abort.abort();
    await Promise.all([...this.running.values()].map((r) => r.done));
    await this.listener?.end().catch(() => {});
    await this.mailboxServer.stop();
  }
}

/** For the API: ask whichever runner holds the attempt to cancel it. */
export async function requestCancel(db: Db, attemptId: string): Promise<void> {
  await db.update(attempts).set({ cancelRequestedAt: new Date() }).where(eq(attempts.id, attemptId));
  await db.execute(sql`select pg_notify(${CANCEL_CHANNEL}, ${attemptId})`);
}
