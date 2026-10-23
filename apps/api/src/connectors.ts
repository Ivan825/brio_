// Turning a stored connector row into what an adapter needs: the registry preset, the effective base URL and the
// credential (revealed just in time, never logged).
import { type AgentAdapter, adapterFor, type ConnectorConfig, type SecretHandle } from "@brio/adapters";
import type { schema } from "@brio/db";
import { type ApiStyle, type Preset, registry } from "@brio/registry";
import type { AppContext } from "./context";
import { HttpError } from "./http";

export type ConnectorRow = typeof schema.connectors.$inferSelect;

/** What we keep in connectors.config (no secrets: the key lives in the vault, referenced by credential_ref). */
export interface StoredConnectorConfig {
  preset: string;
  baseUrl: string;
  region?: string;
  apiStyle?: ApiStyle;
}

export function presetOf(key: string): Preset {
  const preset = registry().preset(key);
  if (!preset) throw new HttpError(422, `unknown preset ${key}`, "unknown_preset");
  return preset;
}

export function connectorConfig(row: ConnectorRow): ConnectorConfig {
  const stored = row.config as unknown as StoredConnectorConfig;
  const preset = presetOf(stored.preset);
  return {
    registryKey: row.registryKey,
    presetKey: stored.preset,
    preset,
    baseUrl: stored.baseUrl,
    ...(stored.apiStyle ? { apiStyle: stored.apiStyle } : {}),
  };
}

export function adapterOf(row: ConnectorRow): AgentAdapter {
  const adapter = adapterFor(connectorConfig(row).preset.family);
  if (!adapter) throw new HttpError(422, `no adapter for ${row.registryKey}`, "no_adapter");
  return adapter;
}

export async function credentialOf(ctx: AppContext, row: ConnectorRow): Promise<SecretHandle | null> {
  if (!row.credentialRef) return null;
  return ctx.vault.reveal(ctx.db, row.workspaceId, row.credentialRef);
}
