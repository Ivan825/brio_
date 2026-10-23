import { bigint, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { id } from "./columns";
import { missions } from "./missions";
import { workspaces } from "./tenancy";

/** The spine: append-only (a trigger blocks UPDATE, DELETE and TRUNCATE). `seq` is gapless per mission. */
export const events = pgTable(
  "events",
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id),
    missionId: uuid()
      .notNull()
      .references(() => missions.id),
    taskId: uuid(),
    attemptId: uuid(),
    seq: bigint({ mode: "number" }).notNull(),
    type: text().notNull(),
    actor: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    ts: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("events_mission_seq").on(t.missionId, t.seq), index().on(t.workspaceId, t.ts)],
);
