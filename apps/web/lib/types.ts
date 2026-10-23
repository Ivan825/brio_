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
  preset: string;
  presetName: string;
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
