import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { deletedAt, id, timestamps } from "./columns";
import { connectorRoute, connectorStatus, sandboxProfile } from "./enums";
import { vaultSecrets } from "./governance";
import { workspaces } from "./tenancy";

const ws = () =>
  uuid()
    .notNull()
    .references(() => workspaces.id);

export const connectors = pgTable(
  "connectors",
  {
    id: id(),
    workspaceId: ws(),
    /** → registry/connectors.json id */
    registryKey: text().notNull(),
    displayName: text().notNull(),
    route: connectorRoute().notNull(),
    credentialRef: uuid().references(() => vaultSecrets.id),
    config: jsonb().$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    health: jsonb().$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    status: connectorStatus().notNull().default("active"),
    ...timestamps(),
    deletedAt: deletedAt(),
  },
  (t) => [index().on(t.workspaceId)],
);

export const agents = pgTable(
  "agents",
  {
    id: id(),
    workspaceId: ws(),
    connectorId: uuid()
      .notNull()
      .references(() => connectors.id),
    name: text().notNull(),
    /** Model id as data, from the provider's live list (CLAUDE.md rule 8). */
    model: text().notNull(),
    rolePrompt: text().notNull().default(""),
    tools: jsonb().$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    limits: jsonb().$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    sandboxProfile: sandboxProfile().notNull().default("standard"),
    tags: text().array().notNull().default(sql`'{}'::text[]`),
    ...timestamps(),
    deletedAt: deletedAt(),
  },
  (t) => [index().on(t.workspaceId), index().on(t.connectorId)],
);

export const crews = pgTable(
  "crews",
  {
    id: id(),
    workspaceId: ws(),
    name: text().notNull(),
    agentIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    routingPrefs: jsonb().$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    ...timestamps(),
    deletedAt: deletedAt(),
  },
  (t) => [index().on(t.workspaceId)],
);
