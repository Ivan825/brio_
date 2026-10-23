// The attempt queue (pg-boss on the same Postgres, D-03). The attempt row is the source of truth: a job only says
// "look at attempt X", and the runner's claim (queued → running) makes duplicate jobs harmless.
import { PgBoss } from "pg-boss";

export const ATTEMPT_QUEUE = "brio-attempts";
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
  return boss;
}

export function enqueueAttempt(boss: PgBoss, attemptId: string): Promise<string | null> {
  return boss.send(ATTEMPT_QUEUE, { attemptId } satisfies AttemptJob);
}
