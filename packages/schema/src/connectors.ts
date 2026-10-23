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
}).extend(SoftDeletable.shape);
export type Agent = z.infer<typeof Agent>;
