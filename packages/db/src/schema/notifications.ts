// Notifications (BUILD_PLAN M9): what each person wants to hear about and where (email, browser push, Slack), their
// browsers' push subscriptions, a workspace's Slack app, and a log of every notification sent (also what keeps one
// event from notifying anyone twice).
import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { createdAt, id, timestamps } from "./columns";
import { vaultSecrets } from "./governance";
import { workspaces } from "./tenancy";

export interface NotificationPrefs {
  channels: { email: boolean; push: boolean; slack: boolean };
  /** approvals: plans and actions waiting for a yes; questions: agents asking; missions: done or failed; budgets. */
  kinds: { approvals: boolean; questions: boolean; missions: boolean; budgets: boolean };
}

export const notificationPrefs = pgTable(
  "notification_prefs",
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    prefs: jsonb().$type<NotificationPrefs>().notNull(),
    ...timestamps(),
  },
  (t) => [uniqueIndex().on(t.workspaceId, t.userId)],
);

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text().notNull().unique(),
    keys: jsonb().$type<{ p256dh: string; auth: string }>().notNull(),
    userAgent: text(),
    lastUsedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.userId)],
);

/** A workspace's Slack app: the channel it posts to; its bot token and signing secret in the vault. */
export const slackApps = pgTable("slack_apps", {
  id: id(),
  workspaceId: uuid()
    .notNull()
    .unique()
    .references(() => workspaces.id),
  teamId: text(),
  channelId: text().notNull(),
  botTokenRef: uuid()
    .notNull()
    .references(() => vaultSecrets.id),
  signingSecretRef: uuid()
    .notNull()
    .references(() => vaultSecrets.id),
  enabled: boolean().notNull().default(true),
  ...timestamps(),
});

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id),
    /** The event it is about. */
    eventId: uuid().notNull(),
    /** null for a channel message (Slack). */
    userId: uuid().references(() => users.id, { onDelete: "cascade" }),
    channel: text().notNull(),
    kind: text().notNull(),
    status: text().notNull().default("sent"),
    error: text(),
    detail: jsonb().$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.workspaceId, t.createdAt),
    uniqueIndex().on(t.eventId, t.channel, t.userId).where(sql`${t.userId} is not null`),
    uniqueIndex().on(t.eventId, t.channel).where(sql`${t.userId} is null`),
  ],
);
