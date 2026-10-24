import type { EvalRun } from "@brio/schema";
import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
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

/** One point per score update, for the scoreboard's trend lines. */
export const scoreHistory = pgTable(
  "score_history",
  {
    id: id(),
    workspaceId: uuid().references(() => workspaces.id),
    agentKey: text().notNull(),
    taskType: text().notNull(),
    passRate: doublePrecision().notNull(),
    elo: doublePrecision().notNull(),
    n: integer().notNull(),
    at: createdAt(),
  },
  (t) => [index().on(t.workspaceId, t.agentKey, t.taskType, t.at)],
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

/** Golden-mission eval runs (BUILD_PLAN M5): the whole run (schema EvalRun) for the evals dashboard. */
export const evalRuns = pgTable(
  "eval_runs",
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id),
    /** offline (simulated agents) or live (real agents and keys). */
    mode: text().notNull(),
    run: jsonb().$type<EvalRun>().notNull(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.workspaceId, t.createdAt)],
);

/**
 * Who has contributed to a global score (D-14), as a salted hash of the workspace: global numbers are only used once
 * enough different workspaces stand behind them, and no workspace can be read out of them.
 */
export const scoreContributors = pgTable(
  "score_contributors",
  {
    agentKey: text().notNull(),
    taskType: text().notNull(),
    contributor: text().notNull(),
    at: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.agentKey, t.taskType, t.contributor] })],
);
