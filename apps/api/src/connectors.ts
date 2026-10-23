// Turning a stored connector row into what an adapter needs: the registry preset, the effective base URL and the
// credential (revealed just in time, never logged).
import {
  type AgentAdapter,
  adapterFor,
  type CliSpec,
  type ConnectorConfig,
  type SecretHandle,
  type ToolRef,
} from "@brio/adapters";
import type { ModelPrice } from "@brio/core";
import { schema } from "@brio/db";
import {
  type ApiStyle,
  type ConnectorEntry,
  type Preset,
  parsePlannedAdapter,
  registry,
  type Service,
} from "@brio/registry";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import type { AppContext } from "./context";
import { HttpError } from "./http";

export type ConnectorRow = typeof schema.connectors.$inferSelect;

/** What we keep in connectors.config (no secrets: the key lives in the vault, referenced by credential_ref). */
export interface StoredConnectorConfig {
  /** The adapter, when it is not the preset's model-API family (a coding CLI). */
  adapter?: string;
  /** The model-API preset; for CLIs, the CLI vendor's (key checks, model lists, prices). */
  preset?: string;
  /** Service connectors (hosted agents, media, search, browsers): the registry service and its install settings. */
  service?: string;
  settings?: Record<string, string>;
  /** The task types this connector's agents take, when the person or its Agent Card says (A2A agents). */
  taskTypes?: string[];
  /** An A2A agent's card as read at install: its name, what it says it does, its skills. */
  agentCard?: {
    name: string;
    description: string;
    skills: Array<{ id: string; name: string; description: string }>;
  };
  /** A vendor webhook registered for this connector (Manus): where it points, and its id or why it failed. */
  webhook?: { url: string; id?: string | null; error?: string };
  baseUrl: string;
  region?: string;
  apiStyle?: ApiStyle;
}

export function presetOf(key: string): Preset {
  const preset = registry().preset(key);
  if (!preset) throw new HttpError(422, `unknown preset ${key}`, "unknown_preset");
  return preset;
}

export function serviceOf(key: string): Service {
  const service = registry().service(key);
  if (!service) throw new HttpError(422, `unknown service ${key}`, "unknown_service");
  return service;
}

export function connectorConfig(row: ConnectorRow): ConnectorConfig {
  const stored = row.config as unknown as StoredConnectorConfig;
  if (stored.service)
    return {
      registryKey: row.registryKey,
      serviceKey: stored.service,
      service: serviceOf(stored.service),
      settings: stored.settings ?? {},
      baseUrl: stored.baseUrl,
    };
  if (!stored.preset)
    throw new HttpError(422, `${row.registryKey} has neither a preset nor a service`, "misconfigured");
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
  const cc = connectorConfig(row);
  const key = stored.adapter ?? cc.service?.adapter ?? cc.preset?.family ?? "";
  const adapter = adapterFor(key);
  if (!adapter) throw new HttpError(422, `no adapter for ${row.registryKey}`, "no_adapter");
  return adapter;
}

/** Who is behind a connector: the preset's vendor, or the service's (the vocabulary reviewers are diversified by). */
export const vendorOf = (cc: ConnectorConfig): string => {
  // Each A2A agent is its own vendor (by host), so one can review another's work.
  if (cc.service?.adapter === "a2a") {
    try {
      return `a2a:${new URL(cc.baseUrl).host}`;
    } catch {
      return "a2a";
    }
  }
  return cc.service?.vendor ?? cc.presetKey ?? cc.registryKey;
};

/** Typical cost of one run of a service agent before the scoreboard knows better (for budget fit and routing). */
const SERVICE_ESTIMATE_USD: Record<string, number> = {
  hosted: 1,
  media: 0.2,
  research: 0.3,
  "cloud-browser": 0,
  search: 0.02,
  fetch: 0.01,
  browser: 0.5,
};

export interface Metering {
  /** Token price, for model APIs and services billed in tokens. */
  price: ModelPrice | null;
  /** USD per unit, for services billed in ACUs, credits, images, seconds or characters. */
  unitPrice: { unit: string; usd: number } | null;
  /** Can it run at all: a price is known, the vendor reports cost, or the run is bounded by time only. */
  runnable: boolean;
  /** Why not, when it cannot. */
  reason: string | null;
  estUsd: number;
  /** Where the price comes from, for the attempt's record: override, table…, vendor_reported, unit, unmetered. */
  priceKind: string;
}

/**
 * How an agent's runs are metered (D-30, D-62): model presets by their token price; services by their unit — tokens at
 * their price preset, USD the vendor reports, the agent's USD per unit, or nothing but the time limit.
 */
export async function meteringOf(
  ctx: AppContext,
  cc: ConnectorConfig,
  adapter: AgentAdapter,
  agent: { model: string; priceOverride: ModelPrice | null; options: Record<string, unknown> },
): Promise<Metering> {
  const cli = (adapter as { spec?: CliSpec }).spec;
  if (cc.service) {
    const unit = cc.service.pricing.unit;
    const est = Number(agent.options.estimatedUsdPerRun ?? SERVICE_ESTIMATE_USD[cc.service.kind] ?? 0.5);
    if (unit === "token") {
      const resolved = await ctx.pricing.lookup({
        presetKey: cc.service.pricing.pricePreset ?? "",
        model: agent.model,
        override: agent.priceOverride,
      });
      const price = resolved.kind === "unknown" ? null : resolved.price;
      return {
        price,
        unitPrice: null,
        runnable: price !== null,
        reason: price ? null : `no price is known for ${agent.model}; set one on the agent`,
        estUsd: est,
        priceKind: resolved.kind,
      };
    }
    if (unit === "usd" || unit === "unmetered")
      return {
        price: null,
        unitPrice: null,
        runnable: true,
        reason: null,
        estUsd: unit === "usd" ? est : 0,
        priceKind: unit === "usd" ? "vendor_reported" : "unmetered",
      };
    const usd = Number(agent.options.usdPerUnit ?? cc.service.pricing.usdPerUnit);
    return Number.isFinite(usd) && usd >= 0
      ? {
          price: null,
          unitPrice: { unit, usd },
          runnable: true,
          reason: null,
          estUsd: est,
          priceKind: "unit",
        }
      : {
          price: null,
          unitPrice: null,
          runnable: false,
          reason: `${cc.service.name} bills in ${unit}s; set the agent's USD per ${unit} (options.usdPerUnit)`,
          estUsd: est,
          priceKind: "unknown",
        };
  }
  const preset = cc.preset as Preset;
  const resolved = await ctx.pricing.lookup({
    presetKey: cc.presetKey ?? "",
    model: agent.model,
    override: agent.priceOverride,
  });
  const price = resolved.kind === "unknown" ? null : resolved.price;
  const runnable =
    price !== null || preset.reportsCost || Boolean(cli?.reportsCost) || Boolean(cli?.unmetered);
  return {
    price,
    unitPrice: null,
    runnable,
    reason: runnable ? null : `no price is known for ${agent.model}; set one on the agent`,
    estUsd: 0,
    priceKind: price ? resolved.kind : "vendor_reported",
  };
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

/**
 * The workspace's tools for an attempt: search and fetch (ADAPTER_SPEC §2.9) and a cloud browser for computer use — the
 * oldest active, healthy connector of each kind. A confidential task gets none, so nothing of it leaves for a third party.
 */
export async function toolsFor(
  ctx: AppContext,
  workspaceId: string,
  sensitivity: string,
): Promise<{ search?: ToolRef; fetch?: ToolRef; browser?: ToolRef } | undefined> {
  if (sensitivity === "confidential") return undefined;
  const rows = await ctx.db
    .select()
    .from(schema.connectors)
    .where(
      and(
        eq(schema.connectors.workspaceId, workspaceId),
        isNull(schema.connectors.deletedAt),
        ne(schema.connectors.status, "disabled"),
      ),
    )
    .orderBy(asc(schema.connectors.createdAt));
  const out: { search?: ToolRef; fetch?: ToolRef; browser?: ToolRef } = {};
  const slot = { search: "search", fetch: "fetch", "cloud-browser": "browser" } as const;
  for (const row of rows) {
    const stored = row.config as unknown as StoredConnectorConfig;
    if (!stored.service) continue;
    const sv = registry().service(stored.service);
    const kind = sv ? slot[sv.kind as keyof typeof slot] : undefined;
    if (!sv || !kind || out[kind]) continue;
    if ((row.health as { ok?: boolean }).ok === false) continue;
    out[kind] = {
      connectorId: row.id,
      credentialRef: row.credentialRef,
      connector: connectorConfig(row),
      usdPerUnit:
        sv.pricing.unit === "usd" || sv.pricing.unit === "unmetered" ? null : (sv.pricing.usdPerUnit ?? null),
    };
  }
  return out.search || out.fetch || out.browser ? out : undefined;
}
