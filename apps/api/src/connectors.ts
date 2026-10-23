// Turning a stored connector row into what an adapter needs: the registry preset, the effective base URL and the
// credential (revealed just in time, never logged).
import {
  type AgentAdapter,
  adapterFor,
  type CliSpec,
  type ConnectorConfig,
  type SecretHandle,
} from "@brio/adapters";
import type { schema } from "@brio/db";
import {
  type ApiStyle,
  type ConnectorEntry,
  type Preset,
  parsePlannedAdapter,
  registry,
} from "@brio/registry";
import type { AppContext } from "./context";
import { HttpError } from "./http";

export type ConnectorRow = typeof schema.connectors.$inferSelect;

/** What we keep in connectors.config (no secrets: the key lives in the vault, referenced by credential_ref). */
export interface StoredConnectorConfig {
  /** The adapter, when it is not the preset's model-API family (a coding CLI). */
  adapter?: string;
  /** The model-API preset; for CLIs, the CLI vendor's (key checks, model lists, prices). */
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
  const stored = row.config as unknown as StoredConnectorConfig;
  const adapter = adapterFor(stored.adapter ?? connectorConfig(row).preset.family);
  if (!adapter) throw new HttpError(422, `no adapter for ${row.registryKey}`, "no_adapter");
  return adapter;
}

export async function credentialOf(ctx: AppContext, row: ConnectorRow): Promise<SecretHandle | null> {
  if (!row.credentialRef) return null;
  return ctx.vault.reveal(ctx.db, row.workspaceId, row.credentialRef);
}

/** The coding-CLI adapter planned for a registry entry, if that is what it is. */
export function cliFor(entry: ConnectorEntry): { adapter: AgentAdapter; spec: CliSpec } | null {
  if (!entry.plannedAdapter) return null;
  const adapter = adapterFor(parsePlannedAdapter(entry.plannedAdapter).family);
  const spec = (adapter as { spec?: CliSpec } | undefined)?.spec;
  return adapter && adapter.route === "cli" && spec ? { adapter, spec } : null;
}

/**
 * The presets a user can install an entry with: its own model-API presets, or, for a coding CLI, its vendor's preset
 * (the key is the vendor's; it is checked and priced through the vendor's API).
 */
export function installablePresets(
  entry: ConnectorEntry,
): Array<{ key: string; preset: Preset; adapter?: string }> {
  const cli = cliFor(entry);
  if (cli) {
    const preset = registry().preset(cli.spec.vendorPreset);
    return preset ? [{ key: cli.spec.vendorPreset, preset, adapter: cli.adapter.key }] : [];
  }
  return registry().presetsFor(entry.id);
}
