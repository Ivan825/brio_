import { z } from "zod";
import { Id, Json, SoftDeletable, Usd, WorkspaceScoped } from "./common";

export const ConnectorRoute = z.enum(["api", "cli", "sdk", "hosted", "a2a", "mcp", "browser", "local"]);
export type ConnectorRoute = z.infer<typeof ConnectorRoute>;

export const ConnectorStatus = z.enum(["active", "disabled", "error"]);

export const ConnectorHealth = z.object({
  ok: z.boolean(),
  checkedAt: z.iso.datetime().optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

/** An installed connector (an entry of registry/connectors.json plus the workspace's credential and config). */
export const Connector = WorkspaceScoped.extend({
  registryKey: z.string().min(1),
  displayName: z.string().trim().min(1).max(80),
  route: ConnectorRoute,
  credentialRef: Id.nullable(),
  config: Json,
  health: ConnectorHealth.partial(),
  status: ConnectorStatus,
}).extend(SoftDeletable.shape);
export type Connector = z.infer<typeof Connector>;

export const AgentLimits = z.object({
  maxTokens: z.number().int().positive().optional(),
  maxMinutes: z.number().positive().optional(),
  maxCostUsd: Usd.optional(),
});

/** USD per million tokens (packages/core ModelPrice). */
export const ModelPrice = z.object({
  inputPerM: z.number().nonnegative(),
  outputPerM: z.number().nonnegative(),
  cachedInputPerM: z.number().nonnegative().nullable(),
  cacheWritePerM: z.number().nonnegative().nullable(),
  longContext: z
    .object({
      thresholdTokens: z.number().int().positive(),
      inputPerM: z.number().nonnegative(),
      outputPerM: z.number().nonnegative(),
      cachedInputPerM: z.number().nonnegative().nullable(),
    })
    .nullable()
    .optional(),
  offPeak: z
    .object({
      multiplier: z.number().positive().max(1),
      peakUtcHours: z.array(z.tuple([z.number().min(0).max(24), z.number().min(0).max(24)])),
      weekdaysOnly: z.boolean(),
    })
    .nullable()
    .optional(),
});
export type ModelPrice = z.infer<typeof ModelPrice>;

export const PriceSource = z.enum(["vendor_docs", "openrouter", "models_endpoint"]);
export type PriceSource = z.infer<typeof PriceSource>;

export const SandboxProfile = z.enum(["none", "readonly", "standard", "networked"]);

/** A configured worker: connector + model + role prompt + limits. Model names are data (CLAUDE.md rule 8). */
export const Agent = WorkspaceScoped.extend({
  connectorId: Id,
  name: z.string().trim().min(1).max(80),
  model: z.string().min(1),
  rolePrompt: z.string(),
  tools: z.array(z.object({ kind: z.literal("mcp"), name: z.string(), url: z.string() })),
  limits: AgentLimits,
  sandboxProfile: SandboxProfile,
  tags: z.array(z.string()),
  /** The user's own price for a model the pricing table does not know (or a negotiated rate). */
  priceOverride: ModelPrice.nullable(),
  /** Vendor request options passed through, e.g. temperature or reasoning effort. */
  options: z.record(z.string(), z.unknown()),
}).extend(SoftDeletable.shape);
export type Agent = z.infer<typeof Agent>;
