// The attempt queue (pg-boss on the same Postgres, D-03). The attempt row is the source of truth: a job only says
// "look at attempt X", and the runner's claim (queued → running) makes duplicate jobs harmless.
import { PgBoss } from "pg-boss";
import type { IntegrationJob } from "./integrate";

export const ATTEMPT_QUEUE = "brio-attempts";
/** Command checks (tests, typecheck, lint, build) on a finished attempt's branch. */
export const CHECK_QUEUE = "brio-checks";
/** Merge-engine rounds: merge a mission's finished branches and check the result. */
export const INTEGRATE_QUEUE = "brio-integrate";
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
