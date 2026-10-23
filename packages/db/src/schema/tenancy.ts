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
