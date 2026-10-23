import type { ModelPrice } from "@brio/schema";
import { sql } from "drizzle-orm";
import { index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { deletedAt, id, timestamps } from "./columns";
import { connectorRoute, connectorStatus, priceSource, sandboxProfile } from "./enums";
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
    priceOverride: jsonb().$type<ModelPrice>(),
    options: jsonb().$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    ...timestamps(),
    deletedAt: deletedAt(),
  },
  (t) => [index().on(t.workspaceId), index().on(t.connectorId)],
);

/** The connector's live model list, cached from its last refresh (CLAUDE.md rule 8: model names are data). */
export const connectorModels = pgTable(
  "connector_models",
  {
    id: id(),
    workspaceId: ws(),
    connectorId: uuid()
      .notNull()
      .references(() => connectors.id),
    model: text().notNull(),
    displayName: text(),
    contextTokens: integer(),
    maxOutputTokens: integer(),
    meta: jsonb().$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    listedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.connectorId, t.model), index().on(t.workspaceId)],
);

const perM = () => numeric({ precision: 14, scale: 6, mode: "number" });

/**
 * Public list prices per (preset, model), USD per million tokens. Global, not per workspace: prices are public data.
 * Refreshed by the pricing updater; every cost event records the price it used, so history lives in the events.
 */
export const modelPrices = pgTable(
  "model_prices",
  {
    id: id(),
    presetKey: text().notNull(),
    model: text().notNull(),
    inputPerM: perM().notNull(),
    outputPerM: perM().notNull(),
    cachedInputPerM: perM(),
    cacheWritePerM: perM(),
    longContext: jsonb().$type<NonNullable<ModelPrice["longContext"]>>(),
    offPeak: jsonb().$type<NonNullable<ModelPrice["offPeak"]>>(),
    /** ISO 4217. Non-USD prices are converted with the deployment's FX rates at lookup; no rate, no price. */
    currency: text().notNull().default("USD"),
    source: priceSource().notNull(),
    sourceUrl: text().notNull(),
    fetchedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.presetKey, t.model)],
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
