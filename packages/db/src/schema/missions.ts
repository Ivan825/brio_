import type { PlanGraph, TaskContract } from "@brio/schema";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { id, timestamps } from "./columns";
import { agents } from "./connectors";
import {
  artifactKind,
  attemptRole,
  attemptStatus,
  executionMode,
  missionPriority,
  missionStatus,
  planStatus,
  reviewKind,
  taskStatus,
  verdict,
} from "./enums";
import { projects } from "./projects";
import { workspaces } from "./tenancy";

const ws = () =>
  uuid()
    .notNull()
    .references(() => workspaces.id);
const usd = () => numeric({ precision: 12, scale: 6, mode: "number" });

export const missions = pgTable(
  "missions",
  {
    id: id(),
    workspaceId: ws(),
    projectId: uuid().references(() => projects.id),
    title: text().notNull(),
    goal: text().notNull(),
    status: missionStatus().notNull().default("draft"),
    priority: missionPriority().notNull().default("balanced"),
    budget: jsonb().$type<{ usd?: number; minutes?: number }>().notNull().default(sql`'{}'::jsonb`),
    assumptions: jsonb().$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    report: jsonb().$type<Record<string, unknown>>(),
    createdBy: uuid().references(() => users.id),
    /** Last assigned event seq; incremented under a row lock by the events writer, so seq is gapless. */
    lastEventSeq: bigint({ mode: "number" }).notNull().default(0),
    ...timestamps(),
  },
  (t) => [index().on(t.workspaceId, t.createdAt)],
);

export const plans = pgTable(
  "plans",
  {
    id: id(),
    workspaceId: ws(),
    missionId: uuid()
      .notNull()
      .references(() => missions.id),
    version: integer().notNull(),
    graph: jsonb().$type<PlanGraph>().notNull(),
    status: planStatus().notNull().default("proposed"),
    approvedBy: uuid().references(() => users.id),
    ...timestamps(),
  },
  (t) => [unique().on(t.missionId, t.version)],
);

export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    workspaceId: ws(),
    missionId: uuid()
      .notNull()
      .references(() => missions.id),
    planVersion: integer().notNull(),
    key: text().notNull(),
    type: text().notNull(),
    title: text().notNull(),
    contract: jsonb().$type<TaskContract>().notNull(),
    dependsOn: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    mode: executionMode().notNull().default("single"),
    modeParams: jsonb().$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    pinnedAgentId: uuid().references(() => agents.id),
    status: taskStatus().notNull().default("pending"),
    budget: jsonb().$type<{ usd?: number; minutes?: number }>().notNull().default(sql`'{}'::jsonb`),
    resultArtifactId: uuid(),
    ...timestamps(),
  },
  (t) => [unique().on(t.missionId, t.planVersion, t.key), index().on(t.missionId, t.status)],
);

export const attempts = pgTable(
  "attempts",
  {
    id: id(),
    workspaceId: ws(),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id),
    agentId: uuid()
      .notNull()
      .references(() => agents.id),
    role: attemptRole().notNull(),
    status: attemptStatus().notNull().default("queued"),
    sandboxId: text(),
    worktreeRef: text(),
    startedAt: timestamp({ withTimezone: true }),
    endedAt: timestamp({ withTimezone: true }),
    costUsd: usd().notNull().default(0),
    tokensIn: integer().notNull().default(0),
    tokensOut: integer().notNull().default(0),
    exitReason: text(),
    transcriptRef: text(),
    ...timestamps(),
  },
  (t) => [index().on(t.taskId), index().on(t.agentId)],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: id(),
    workspaceId: ws(),
    kind: artifactKind().notNull(),
    storageRef: text().notNull(),
    sha256: text().notNull(),
    meta: jsonb().$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    attemptId: uuid().references(() => attempts.id),
    ...timestamps(),
  },
  (t) => [index().on(t.attemptId)],
);

export const reviews = pgTable(
  "reviews",
  {
    id: id(),
    workspaceId: ws(),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id),
    attemptId: uuid().references(() => attempts.id),
    reviewerAgentId: uuid().references(() => agents.id),
    reviewerUserId: uuid().references(() => users.id),
    kind: reviewKind().notNull(),
    verdict: verdict().notNull(),
    scores: jsonb().$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
    reasons: text().notNull().default(""),
    evidence: jsonb().$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    ...timestamps(),
  },
  (t) => [
    index().on(t.taskId),
    check("reviews_one_reviewer", sql`num_nonnulls(${t.reviewerAgentId}, ${t.reviewerUserId}) = 1`),
  ],
);
