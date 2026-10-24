// The events writer and reader (ARCHITECTURE §3, "the spine"). Every agent action is an event (CLAUDE.md rule 3).
import { type Event, NewEvent } from "@brio/schema";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { DbOrTx } from "./client";
import { events, missions } from "./schema/index";

export const EVENTS_CHANNEL = "brio_events";

/** Anything that can scrub secrets from a payload (the vault's Redactor). Required: payloads are never stored raw. */
export interface PayloadRedactor {
  redactDeep(value: unknown): unknown;
}

export class MissionNotFoundError extends Error {
  override name = "MissionNotFoundError";
}

export class EventWriter {
  constructor(private readonly redactor: PayloadRedactor) {}

  /**
   * Appends an event with the mission's next seq. The mission row is locked by the UPDATE, so concurrent writers for one
   * mission serialise and commit in seq order: seq is gapless and readers never see seq n+1 before n.
   * A NOTIFY on `brio_events` is delivered when the transaction commits.
   */
  async append(db: DbOrTx, input: NewEvent): Promise<Event> {
    const e = NewEvent.parse(input);
    const payload = this.redactor.redactDeep(e.payload) as Record<string, unknown>;
    return db.transaction(async (tx) => {
      const [m] = await tx
        .update(missions)
        .set({ lastEventSeq: sql`${missions.lastEventSeq} + 1` })
        .where(and(eq(missions.id, e.missionId), eq(missions.workspaceId, e.workspaceId)))
        .returning({ seq: missions.lastEventSeq });
      if (!m)
        throw new MissionNotFoundError(`mission ${e.missionId} not found in workspace ${e.workspaceId}`);
      const [row] = await tx
        .insert(events)
        .values({
          workspaceId: e.workspaceId,
          missionId: e.missionId,
          taskId: e.taskId,
          attemptId: e.attemptId,
          seq: m.seq,
          type: e.type,
          actor: e.actor,
          payload,
          // When the event was written, not when its transaction began (a long one would date it early).
          ts: sql`clock_timestamp()`,
        })
        .returning();
      await tx.execute(
        sql`select pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify({ missionId: e.missionId, seq: m.seq, type: e.type, attemptId: e.attemptId ?? null })})`,
      );
      return row as Event;
    });
  }
}

/** Events of a mission with seq > afterSeq, in order. */
export async function readEventsSince(
  db: DbOrTx,
  missionId: string,
  afterSeq: number,
  limit = 500,
): Promise<Event[]> {
  return (await db
    .select()
    .from(events)
    .where(and(eq(events.missionId, missionId), gt(events.seq, afterSeq)))
    .orderBy(asc(events.seq))
    .limit(limit)) as Event[];
}
