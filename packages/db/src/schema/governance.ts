import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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
import { bytea, createdAt, id, timestamps } from "./columns";
import { approvalStatus, budgetScopeKind, ledgerKind, policyKind } from "./enums";
import { workspaces } from "./tenancy";

const ws = () =>
  uuid()
    .notNull()
    .references(() => workspaces.id);
const usd = () => numeric({ precision: 12, scale: 6, mode: "number" });

export const budgets = pgTable(
  "budgets",
  {
    id: id(),
    workspaceId: ws(),
    scopeKind: budgetScopeKind().notNull(),
    scopeId: uuid().notNull(),
    limitUsd: usd(),
    limitMinutes: integer(),
    spentUsd: usd().notNull().default(0),
    softPct: integer().notNull().default(80),
    /** Workspace and agent budgets reset each calendar month (UTC); the period a warning or stop was for. */
    warnedPeriod: text(),
    stoppedPeriod: text(),
    ...timestamps(),
  },
  (t) => [unique().on(t.scopeKind, t.scopeId)],
);

export const policies = pgTable(
  "policies",
  {
    id: id(),
    workspaceId: ws(),
    kind: policyKind().notNull(),
    name: text().notNull(),
    rule: jsonb().$type<Record<string, unknown>>().notNull(),
    enabled: boolean().notNull().default(true),
    ...timestamps(),
  },
  (t) => [index().on(t.workspaceId, t.kind)],
);

export const approvals = pgTable(
  "approvals",
  {
    id: id(),
    workspaceId: ws(),
    subjectKind: text().notNull(),
    subjectId: uuid().notNull(),
    action: text().notNull(),
    requestedBy: text().notNull(),
    status: approvalStatus().notNull().default("pending"),
    decidedBy: uuid().references(() => users.id),
    decidedAt: timestamp({ withTimezone: true }),
    reason: text(),
    ...timestamps(),
  },
  (t) => [index().on(t.workspaceId, t.status)],
);

/**
 * Append-only, hash-chained audit ledger, one chain per workspace.
 * hash = sha256(prev_hash || canonical_json(payload-with-kind-and-seq)). A trigger blocks UPDATE, DELETE and TRUNCATE.
 */
export const ledger = pgTable(
  "ledger",
  {
    id: id(),
    workspaceId: ws(),
    // Null while the entry waits to be chained (D-98): set once, by the chainer, and never again (a trigger).
    seq: bigint({ mode: "number" }),
    prevHash: text(),
    hash: text().unique(),
    kind: ledgerKind().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.workspaceId, t.seq),
    // What the chainer looks for, many times a second: kept small by being only the pending rows.
    index("ledger_pending_index").on(t.workspaceId).where(sql`${t.hash} is null`),
  ],
);

/** BYOK secrets under envelope encryption: a per-secret data key (DEK) wrapped by a key-encryption key (KEK). */
export const vaultSecrets = pgTable(
  "vault_secrets",
  {
    id: id(),
    workspaceId: ws(),
    label: text().notNull(),
    /** AES-256-GCM: iv (12) || tag (16) || ciphertext. */
    ciphertext: bytea().notNull(),
    dekWrapped: bytea().notNull(),
    kekProvider: text().notNull(),
    kekId: text().notNull(),
    lastUsedAt: timestamp({ withTimezone: true }),
    createdBy: uuid().references(() => users.id),
    ...timestamps(),
  },
  (t) => [unique().on(t.workspaceId, t.label)],
);

/**
 * The daily usage reports the billing hook sent (or is still trying to send) to an operator's billing system (D-105):
 * one per workspace and UTC day, so each day is reported exactly once.
 */
export const usageReports = pgTable(
  "usage_reports",
  {
    id: id(),
    workspaceId: ws(),
    /** YYYY-MM-DD, UTC. */
    day: text().notNull(),
    /** sent | failed */
    status: text().notNull(),
    tries: integer().notNull().default(0),
    payload: jsonb().$type<Record<string, unknown>>(),
    lastError: text(),
    sentAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [unique().on(t.workspaceId, t.day)],
);
