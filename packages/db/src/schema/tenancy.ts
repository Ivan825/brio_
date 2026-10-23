// Workspaces are Better Auth organisations (organization → workspaces, member → members, invitation → invitations).
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { createdAt, deletedAt, id, timestamps } from "./columns";
import { invitationStatus, memberRole, workspacePlan } from "./enums";

export const workspaces = pgTable("workspaces", {
  id: id(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  logo: text(),
  /** Better Auth organisation metadata (JSON string). */
  metadata: text(),
  plan: workspacePlan().notNull().default("free"),
  settings: jsonb().$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  ...timestamps(),
  deletedAt: deletedAt(),
});

export const members = pgTable(
  "members",
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRole().notNull().default("member"),
    ...timestamps(),
  },
  (t) => [unique().on(t.workspaceId, t.userId), index().on(t.userId)],
);

export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text().notNull(),
    role: memberRole().notNull().default("member"),
    status: invitationStatus().notNull().default("pending"),
    inviterId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.workspaceId), index().on(t.email)],
);

/**
 * API tokens (M7): how the brio CLI, its stdio MCP server and A2A clients act for a person in one workspace. Only the
 * token's sha256 is kept; the token is shown once. A token never reaches another workspace, and dies with the
 * person's membership.
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text().notNull(),
    /** The token's first characters, so a person can tell tokens apart; never enough to use. */
    prefix: text().notNull(),
    tokenHash: text().notNull().unique(),
    lastUsedAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [index().on(t.workspaceId), index().on(t.userId)],
);

/**
 * Local runners (BUILD_PLAN M8): a person's machine that runs work for the workspace — attempts of the agents bound to
 * it, on the projects that live on it — connected to the API over an outbound WebSocket. Its token is stored hashed.
 */
export const runners = pgTable(
  "runners",
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id),
    /** The person whose machine it is; only their consent covers host mode. */
    ownerId: uuid()
      .notNull()
      .references(() => users.id),
    name: text().notNull(),
    tokenHash: text().notNull().unique(),
    tokenPrefix: text().notNull(),
    /** docker: a container per attempt, as in the cloud; host: no container, with the owner's consent. */
    mode: text().notNull().default("docker"),
    /** What the owner agreed to for host mode, and when. */
    consent: jsonb().$type<{ host: { by: string; at: string; text: string } } | null>(),
    /** What the runner found on the machine when it last connected. */
    capabilities: jsonb()
      .$type<{
        clis?: Array<{ key: string; version: string }>;
        docker?: boolean;
        os?: string;
        version?: string;
      }>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastSeenAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [index().on(t.workspaceId)],
);
