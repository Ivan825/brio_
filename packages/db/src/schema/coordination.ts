import type { HandoffPacket } from "@brio/schema";
import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";
import { contractStatus, leaseMode, leaseResourceKind, messageKind, messageStatus } from "./enums";
import { attempts, missions, tasks } from "./missions";
import { projects } from "./projects";
import { workspaces } from "./tenancy";

const ws = () =>
  uuid()
    .notNull()
    .references(() => workspaces.id);

export const contracts = pgTable(
  "contracts",
  {
    id: id(),
    workspaceId: ws(),
    projectId: uuid().references(() => projects.id),
    /** Contracts agreed inside a mission (a design.api_contract task's output) before they belong to a project. */
    missionId: uuid().references(() => missions.id),
    name: text().notNull(),
    version: text().notNull(),
    spec: jsonb().$type<string | Record<string, unknown>>().notNull(),
    ownerTaskId: uuid().references(() => tasks.id),
    status: contractStatus().notNull().default("draft"),
    ...timestamps(),
  },
  (t) => [index().on(t.workspaceId, t.name)],
);

export const leases = pgTable(
  "leases",
  {
    id: id(),
    workspaceId: ws(),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id),
    resourceKind: leaseResourceKind().notNull(),
    resource: text().notNull(),
    mode: leaseMode().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    releasedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    index("leases_active_idx")
      .on(t.workspaceId, t.resourceKind, t.resource)
      .where(sql`${t.releasedAt} is null`),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    workspaceId: ws(),
    missionId: uuid()
      .notNull()
      .references(() => missions.id),
    fromAttemptId: uuid().references(() => attempts.id),
    toTaskId: uuid().references(() => tasks.id),
    toAttemptId: uuid().references(() => attempts.id),
    toUser: boolean().notNull().default(false),
    kind: messageKind().notNull(),
    /** The question an answer replies to. */
    replyToId: uuid(),
    body: text().notNull(),
    status: messageStatus().notNull().default("open"),
    ...timestamps(),
  },
  (t) => [
    index().on(t.missionId),
    check(
      "messages_one_recipient",
      sql`num_nonnulls(${t.toTaskId}, ${t.toAttemptId}) + ${t.toUser}::int = 1`,
    ),
  ],
);

export const handoffs = pgTable(
  "handoffs",
  {
    id: id(),
    workspaceId: ws(),
    fromTaskId: uuid()
      .notNull()
      .references(() => tasks.id),
    toTaskId: uuid()
      .notNull()
      .references(() => tasks.id),
    packet: jsonb().$type<HandoffPacket>().notNull(),
    ...timestamps(),
  },
  (t) => [index().on(t.toTaskId)],
);
