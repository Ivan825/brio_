import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { createdAt, id } from "./columns";
import { scoreScope } from "./enums";
import { attempts } from "./missions";
import { workspaces } from "./tenancy";

/** Scoreboard: Beta posterior for pass rate, Elo, cost and latency per (agent, task type). */
export const scores = pgTable(
  "scores",
  {
    id: id(),
    scope: scoreScope().notNull(),
    /** Null for global scores. */
    workspaceId: uuid().references(() => workspaces.id),
    /** connector + model, e.g. `openai/gpt-x`. */
    agentKey: text().notNull(),
    taskType: text().notNull(),
    alpha: doublePrecision().notNull().default(1),
    beta: doublePrecision().notNull().default(1),
    elo: doublePrecision().notNull().default(1200),
    avgCost: numeric({ precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    p50LatencyS: doublePrecision().notNull().default(0),
    n: integer().notNull().default(0),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("scores_key").on(t.scope, t.workspaceId, t.agentKey, t.taskType).nullsNotDistinct(),
    index().on(t.workspaceId, t.taskType),
  ],
);

export const ratings = pgTable(
  "ratings",
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id),
    attemptId: uuid()
      .notNull()
      .references(() => attempts.id),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    /** -1 (thumbs down), 0, +1 (thumbs up). */
    rating: smallint().notNull(),
    comment: text(),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.attemptId, t.userId),
    index().on(t.attemptId),
    check("ratings_range", sql`${t.rating} between -1 and 1`),
  ],
);
