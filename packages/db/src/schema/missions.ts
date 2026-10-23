import type { PlanGraph, TaskContract } from "@brio/schema";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { bytea, id, timestamps } from "./columns";
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
    /** The agent that plans this mission; null lets the static router choose (M3) or the scoreboard (M4). */
    plannerAgentId: uuid(),
    /** Start as soon as a plan passes lint, without waiting for approval (policy permitting). */
    autoApprove: boolean().notNull().default(false),
    /** learned (default), static, or single with an agentId (schema MissionRouting). */
    routing: jsonb()
      .$type<{ strategy: "learned" } | { strategy: "static" } | { strategy: "single"; agentId: string }>()
      .notNull()
      .default(sql`'{"strategy":"learned"}'::jsonb`),
    /** Why the mission cannot move (no agents, open questions...); null when it can. */
    blockedReason: text(),
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
    /** planner (proposed by the planning task), user (an edit) or replan. */
    origin: text().notNull().default("planner"),
    /** Plan lint result: errors block approval, warnings and automatic fixes are shown. */
    lint: jsonb().$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
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
    /** Revise loops used (ARCHITECTURE §4.2: at most 2). */
    revisions: integer().notNull().default(0),
    blockedReason: text(),
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
    /**
     * Exactly what was dispatched, resolved by the API before queueing: rendered input, agent and connector config
     * (no secrets), price, limits and sandbox spec. The runner executes this and nothing else.
     */
    dispatch: jsonb().$type<Record<string, unknown>>(),
    /** The runner holding the attempt and its last sign of life; the reaper fails attempts whose heartbeat stops. */
    runnerId: text(),
    heartbeatAt: timestamp({ withTimezone: true }),
    cancelRequestedAt: timestamp({ withTimezone: true }),
    /** The acceptance checks run on this attempt's result and their outcomes (the verifier's working state). */
    checks: jsonb().$type<Record<string, unknown>>(),
    /** The outcome this attempt contributed to the scoreboard (pass, revise, fail), so it is counted once. */
    scored: text(),
    ...timestamps(),
  },
  (t) => [index().on(t.taskId), index().on(t.agentId), index().on(t.status, t.heartbeatAt)],
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

/**
 * Content-addressed artifact bodies (agent answers, reports, small files), per workspace. `artifacts.storage_ref` is
 * `blob:<sha256>`. Large binaries move to object storage later; the ref scheme keeps that a storage change only.
 */
export const blobs = pgTable(
  "blobs",
  {
    workspaceId: ws(),
    sha256: text().notNull(),
    contentType: text().notNull(),
    size: integer().notNull(),
    bytes: bytea().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.sha256] })],
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

/**
 * The merge engine's integration runs (ROUTING §4, BUILD_PLAN M5): every finished code task's branch merged in plan
 * order onto one integration branch, then every hard command check run on the result. A conflict becomes a
 * merge.integrate task and a failing check a fix task; each round is a row.
 */
export const integrations = pgTable(
  "integrations",
  {
    id: id(),
    workspaceId: ws(),
    missionId: uuid()
      .notNull()
      .references(() => missions.id),
    planVersion: integer().notNull(),
    round: integer().notNull(),
    /** queued, running, passed, failed (a check failed), conflict (the branches do not merge). */
    status: text().notNull().default("queued"),
    /** The branches merged, in order: each finished code task's result. */
    refs: jsonb().$type<Array<{ taskId: string; taskKey: string; ref: string }>>().notNull(),
    /** The repository the branches live in (null: the mission's own empty repository). */
    repo: jsonb().$type<{ url: string; branch: string | null } | null>(),
    branch: text(),
    commit: text(),
    base: text(),
    conflicts: jsonb()
      .$type<Array<{ between: [string, string]; files: string[] }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** The commands run on the merged result and how each went. */
    checks: jsonb()
      .$type<Array<{ command: string; passed: boolean; exitCode: number | null; output: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    diffArtifactId: uuid().references(() => artifacts.id),
    error: text(),
    ...timestamps(),
  },
  (t) => [uniqueIndex().on(t.missionId, t.planVersion, t.round)],
);

/**
 * What a finished mission hands back (BUILD_PLAN M8): its integration branch pushed to the project repository, and a
 * pull request opened when the host has an API for one. Pushing is irreversible, so each delivery waits on an approval.
 */
export const deliveries = pgTable(
  "deliveries",
  {
    id: id(),
    workspaceId: ws(),
    missionId: uuid()
      .notNull()
      .references(() => missions.id),
    integrationId: uuid().references(() => integrations.id),
    approvalId: uuid().notNull(),
    /** pull_request (push, then open one) or branch (push only). */
    kind: text().notNull(),
    /** awaiting_approval, queued, running, done, failed, denied. */
    status: text().notNull().default("awaiting_approval"),
    /** The repository, and the branch the pull request asks to merge into. */
    repo: jsonb().$type<{ url: string; base: string | null }>().notNull(),
    /** The branch pushed. */
    branch: text().notNull(),
    commit: text().notNull(),
    title: text().notNull(),
    url: text(),
    number: integer(),
    error: text(),
    ...timestamps(),
  },
  (t) => [index().on(t.missionId), uniqueIndex().on(t.approvalId)],
);
