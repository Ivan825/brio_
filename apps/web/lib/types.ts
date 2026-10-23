// Shapes of the API responses the web app reads. The API is the source of truth (apps/api/src/routes).

export interface PresetSummary {
  key: string;
  name: string;
  family: string;
  auth: "bearer" | "x-api-key" | "x-goog-api-key" | "optional-bearer" | "none";
  baseUrl: string | null;
  baseUrlEditable: boolean;
  regions: Record<string, string>;
  apiStyles: ("responses" | "chat")[];
  local: boolean;
  regionLimited: string | null;
  docsUrl: string;
  verifiedOn: string;
  notes: string | null;
}

/** A service connector's install facts (registry `services`, D-62): hosted agents, media, research, search, browsers. */
export interface ServiceSummary {
  key: string;
  name: string;
  kind: "hosted" | "media" | "research" | "search" | "fetch" | "browser" | "cloud-browser" | "a2a" | "mcp";
  credential: { kind: "key" | "json"; hint: string; optional?: boolean };
  settings: Array<{
    key: string;
    label: string;
    required: boolean;
    pattern?: string;
    placeholder?: string;
    help?: string;
  }>;
  pricing: { unit: string; usdPerUnit?: number; perCallUsd?: number; pricePreset?: string; note: string };
  keyCheck: boolean;
  docsUrl: string;
  verifiedOn: string;
  notes: string | null;
}

export interface CatalogueConnector {
  id: string;
  name: string;
  maker: string;
  routes: string[];
  howToConnect: string;
  status: string;
  statusKey: "v" | "e" | "p" | "d" | "x";
  tier: string;
  notes: string;
  supported: boolean;
  buildMilestone: string | null;
  plannedAdapter: string | null;
  implemented: boolean;
  regionLimited: string | null;
  taskTypes: string[];
  /** Set for coding CLIs: they run in a sandbox with the key of their vendor's preset. */
  cli: string | null;
  presets: PresetSummary[];
  services: ServiceSummary[];
  /** For unsupported entries: the supported connectors that do the same job legitimately. */
  alternatives: Array<{ id: string; name: string }>;
}

export interface Catalogue {
  generatedOn: string;
  categories: { id: string; name: string; description: string; connectors: CatalogueConnector[] }[];
}

export interface Health {
  ok?: boolean;
  checkedAt?: string;
  latencyMs?: number;
  detail?: string | null;
  error?: string;
  code?: string;
}

export interface InstalledConnector {
  id: string;
  registryKey: string;
  name: string;
  displayName: string;
  route: string;
  /** The model-API preset; null for service connectors. */
  preset: string | null;
  presetName: string | null;
  service: string | null;
  serviceKind: ServiceSummary["kind"] | null;
  settings: Record<string, string>;
  /** The task types its agents take, when set on the connector (A2A agents). */
  taskTypes: string[] | null;
  /** An A2A agent's card as read at install. */
  agentCard: {
    name: string;
    description: string;
    skills: Array<{ id: string; name: string; description: string }>;
  } | null;
  baseUrl: string;
  region: string | null;
  apiStyle: string | null;
  hasKey: boolean;
  health: Health;
  status: "active" | "disabled" | "error";
  regionLimited: string | null;
  local: boolean;
  createdAt: string;
}

export interface Price {
  kind: "override" | "table" | "free";
  inputPerM: number;
  outputPerM: number;
  cachedInputPerM: number | null;
  cacheWritePerM: number | null;
}

export interface ConnectorModel {
  id: string;
  displayName: string | null;
  contextTokens: number | null;
  maxOutputTokens: number | null;
  price: Price | null;
  listedAt: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  model: string;
  rolePrompt: string;
  limits: { maxTokens?: number; maxMinutes?: number; maxCostUsd?: number };
  priceOverride: Omit<Price, "kind"> | null;
  sandboxProfile: string;
  tags: string[];
  connector: { id: string; displayName: string; registryKey: string; preset?: string; status: string } | null;
  price: Price | null;
  runnable: boolean;
  modelListed: boolean;
  createdAt: string;
}

export interface AttemptSummary {
  id: string;
  taskId: string;
  agentId: string;
  role: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  exitReason: string | null;
  purpose: "make" | "revise" | "review" | "judge" | "merge" | null;
  scored: "pass" | "revise" | "fail" | null;
}
