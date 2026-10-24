// Mandate (D-07, SECURITY_GOVERNANCE §7): a workspace may hand spend authority to a Mandate instance. Brio asks the
// workspace's mandate before each paid attempt and settles the hold when the attempt ends.
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { id, timestamps } from "./columns";
import { vaultSecrets } from "./governance";
import { attempts, tasks } from "./missions";
import { workspaces } from "./tenancy";

/** The workspace's mandate: where it lives and its agent token (in the vault). One per workspace. */
export const mandateConnections = pgTable("mandate_connections", {
  id: id(),
  workspaceId: uuid()
    .notNull()
    .unique()
    .references(() => workspaces.id),
  baseUrl: text().notNull(),
  tokenRef: uuid()
    .notNull()
    .references(() => vaultSecrets.id),
  /** As Mandate reported it when connected. */
  mandateId: text().notNull(),
  name: text().notNull(),
  currency: text().notNull(),
  connectedBy: uuid().references(() => users.id),
  ...timestamps(),
});

/**
 * One request for spend authority, for one task's next attempt. A pending request is retried with the same key and
 * amount until Mandate's person decides; an approved one is a hold, captured (or voided) when the attempt ends.
 */
export const mandateHolds = pgTable(
  "mandate_holds",
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id),
    attemptId: uuid().references(() => attempts.id),
    /** The Idempotency-Key sent to Mandate. */
    requestKey: text().notNull().unique(),
    amountCents: integer().notNull(),
    merchant: text().notNull(),
    /** Sent with the request (a retry must send exactly the same body). */
    purpose: text().notNull().default(""),
    /** pending | held | captured | voided | declined */
    status: text().notNull(),
    transactionId: text(),
    approvalId: text(),
    reason: text(),
    capturedCents: integer(),
    settledAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [index().on(t.workspaceId, t.status), uniqueIndex().on(t.attemptId), index().on(t.taskId, t.status)],
);
