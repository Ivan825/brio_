// The attempt queue (pg-boss on the same Postgres, D-03). The attempt row is the source of truth: a job only says
// "look at attempt X", and the runner's claim (queued → running) makes duplicate jobs harmless.
import { PgBoss } from "pg-boss";
import type { DeliveryJob } from "./deliver";
import type { IntegrationJob } from "./integrate";

export const ATTEMPT_QUEUE = "brio-attempts";
/** Command checks (tests, typecheck, lint, build) on a finished attempt's branch. */
export const CHECK_QUEUE = "brio-checks";
/** Merge-engine rounds: merge a mission's finished branches and check the result. */
export const INTEGRATE_QUEUE = "brio-integrate";
/** Approved deliveries: push a finished mission's branch and open its pull request. */
export const DELIVER_QUEUE = "brio-deliver";
/** NOTIFY channel the API uses to ask runners to cancel an attempt. */
export const CANCEL_CHANNEL = "brio_attempt_cancel";

export interface AttemptJob {
  attemptId: string;
}

export async function startQueue(connectionString: string): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, max: 4 });
  boss.on("error", () => {
    // Connection hiccups are retried by pg-boss; the reaper re-enqueues anything lost.
  });
  await boss.start();
  await boss.createQueue(ATTEMPT_QUEUE, { retryLimit: 0, expireInSeconds: 4 * 3600 }).catch(() => {});
  await boss.createQueue(CHECK_QUEUE, { retryLimit: 1, expireInSeconds: 3600 }).catch(() => {});
  await boss.createQueue(INTEGRATE_QUEUE, { retryLimit: 1, expireInSeconds: 3600 }).catch(() => {});
  // A push is not retried blindly: a failed delivery is shown, and a person retries it.
  await boss.createQueue(DELIVER_QUEUE, { retryLimit: 0, expireInSeconds: 1800 }).catch(() => {});
  return boss;
}

export function enqueueAttempt(boss: PgBoss, attemptId: string): Promise<string | null> {
  return boss.send(ATTEMPT_QUEUE, { attemptId } satisfies AttemptJob);
}

export function enqueueChecks(boss: PgBoss, attemptId: string): Promise<string | null> {
  return boss.send(CHECK_QUEUE, { attemptId } satisfies AttemptJob);
}

export function enqueueIntegration(boss: PgBoss, job: IntegrationJob): Promise<string | null> {
  return boss.send(INTEGRATE_QUEUE, job);
}

export function enqueueDelivery(boss: PgBoss, deliveryId: string): Promise<string | null> {
  return boss.send(DELIVER_QUEUE, { deliveryId } satisfies DeliveryJob);
}

/**
 * Takes jobs from one queue for up to `capacity` handlers at a time with a single claim loop: it asks pg-boss for as
 * many jobs as it has free slots, so an idle runner costs the database one small query per queue each `pollMs`,
 * whatever its concurrency (one poller per slot made eight idle runners cost Postgres ~2,000 queries a second).
 * Each job is completed or failed when its handler settles; stopping aborts the running handlers' signals.
 */
export class JobPump<T extends object> {
  private running = 0;
  private stopped = false;
  private readonly active = new Set<AbortController>();
  private wake: (() => void) | null = null;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly boss: PgBoss,
    private readonly queue: string,
    private readonly capacity: number,
    private readonly handle: (job: { id: string; data: T; signal: AbortSignal }) => Promise<void>,
    private readonly pollMs = 500,
  ) {}

  start(): void {
    this.loop ??= this.run();
  }

  /** Jobs being handled now. */
  get busy(): number {
    return this.running;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const free = this.capacity - this.running;
      let full = false;
      if (free > 0) {
        const want = Math.min(free, 50);
        const jobs = await this.boss.fetch<T>(this.queue, { batchSize: want }).catch(() => []);
        for (const job of jobs) this.launch(job.id, job.data);
        // A full batch: more may be waiting, so ask again at once.
        full = jobs.length === want;
      }
      if (!full) await this.pause();
    }
  }

  /** Waits for the next poll, or less when a slot frees up while the runner was full. */
  private pause(): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, this.pollMs);
      const self = this;
      function done() {
        clearTimeout(t);
        self.wake = null;
        resolve();
      }
      this.wake = this.running >= this.capacity ? done : null;
    });
  }

  private launch(id: string, data: T): void {
    this.running++;
    const ac = new AbortController();
    this.active.add(ac);
    void this.handle({ id, data, signal: ac.signal })
      .then(
        () => this.boss.complete(this.queue, id),
        (err: unknown) => this.boss.fail(this.queue, id, { message: String((err as Error)?.message ?? err) }),
      )
      .catch(() => {
        // The job expires and is retried (or the attempt row's state wins): nothing to do here.
      })
      .finally(() => {
        this.running--;
        this.active.delete(ac);
        this.wake?.();
      });
  }

  /** Takes no more jobs and aborts the running handlers' signals; resolves when the claim loop has ended. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const ac of this.active) ac.abort();
    this.wake?.();
    await this.loop;
  }
}
