// The one interface every connector is reached through (docs/ADAPTER_SPEC.md §1). Vendor quirks live only in
// packages/adapters/src/families/<family>/.
import type { ModelPrice, TokenUsage } from "@brio/core";
import type { ApiStyle, Preset, Service } from "@brio/registry";
import type { HandoffPacket, TaskContract, TaskType } from "@brio/schema";

export type Route = "api" | "cli" | "sdk" | "hosted" | "a2a" | "mcp" | "browser" | "local";

export interface AdapterCapabilities {
  taskTypes: TaskType[];
  editsFiles: boolean;
  runsCode: boolean;
  browses: boolean;
  producesMedia: ("image" | "video" | "audio")[];
  streaming: boolean;
  supportsMcpTools: boolean;
  supportsResume: boolean;
  maxContextTokens?: number;
  runnerModes: ("cloud" | "local")[];
}

/** Project memory relevant to a task. Built by packages/memory from M9; empty until then. */
export interface MemoryBrief {
  summary: string;
  items: Array<{ kind: string; title: string; body: string }>;
}

export const EMPTY_BRIEF: MemoryBrief = { summary: "", items: [] };

export interface AttachmentRef {
  kind: string;
  ref: string;
  sha256?: string;
  /** Inline text for small text attachments; binary attachments are referenced only. */
  text?: string;
}

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  url?: string;
  /** For http: request headers (the mailbox's per-attempt bearer token). Secret: never logged. */
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
}

export interface RunLimits {
  maxCostUsd: number;
  maxMinutes: number;
  maxOutputTokens?: number;
  /** Tool-loop turns (model calls) before the run stops with limit_exceeded. */
  maxTurns?: number;
}

export interface RunInput {
  attemptId: string;
  taskTitle: string;
  taskType: TaskType;
  /** Rendered prompt (task + contract + constraints). The role prompt is in AgentConfig. */
  instructions: string;
  contract: TaskContract;
  handoffs: HandoffPacket[];
  brief: MemoryBrief;
  workdir?: string;
  /** The project repository the task works on (hosted agents clone it in their own sandbox when they can reach it). */
  repo?: { url: string; branch: string | null } | null;
  attachments: AttachmentRef[];
  limits: RunLimits;
  mcpServers: McpServerConfig[];
}

/** A connector as installed in a workspace: the registry preset plus the user's overrides. */
export interface ConnectorConfig {
  registryKey: string;
  /** Model-API connectors (and CLIs, by their vendor): the registry preset. Absent for service connectors. */
  presetKey?: string;
  preset?: Preset;
  /** Service connectors (hosted agents, media, search, browsers): the registry service and the install's settings. */
  serviceKey?: string;
  service?: Service;
  settings?: Record<string, string>;
  /** The effective base URL (preset default, region choice, or the user's own for local/proxy presets). */
  baseUrl: string;
  apiStyle?: ApiStyle;
  extraHeaders?: Record<string, string>;
}

/** A configured worker: connector + model + role prompt + limits (Agent in @brio/schema), resolved for a run. */
export interface AgentConfig {
  agentId: string;
  name: string;
  model: string;
  rolePrompt: string;
  connector: ConnectorConfig;
  /** The price used for cost events; null only when the preset is free (local) or the vendor reports cost. */
  price: ModelPrice | null;
  /** Services billed in units (ACUs, credits, images, seconds, characters): USD per unit, from the agent. */
  unitPrice?: { unit: string; usd: number } | null;
  /** Vendor-specific request options passed through (e.g. temperature, reasoning effort). */
  options?: Record<string, unknown>;
}

/** A decrypted credential that never prints itself (SecretValue from @brio/vault satisfies this). */
export interface SecretHandle {
  reveal(): string;
}

/** A process running inside the sandbox. */
export interface SandboxProcess {
  /** stdout, line by line, as the process writes it. */
  lines: AsyncIterable<string>;
  /** Resolves when the process ends; stderr is the last 64 KB. */
  exit: Promise<{ code: number | null; stderr: string }>;
  /** Kills the process. Idempotent. */
  kill(): Promise<void>;
}

/**
 * The sandbox an attempt runs in (one container per attempt, ARCHITECTURE §4.3). Paths are relative to the worktree;
 * anything resolving outside it is refused. Without a sandbox (NO_SANDBOX) every method fails closed.
 */
export interface SandboxHandle {
  readonly available: boolean;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listFiles(path: string): Promise<string[]>;
  exec(
    command: string,
    opts?: { timeoutMs?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Starts a long-running process (a coding CLI) with its own environment; secrets go only in `env`. */
  spawn(argv: string[], opts: { env: Record<string, string>; stdin?: string }): SandboxProcess;
}

/** A logger whose output has already been through the redactor. */
export interface Logger {
  debug(obj: Record<string, unknown> | string, msg?: string): void;
  info(obj: Record<string, unknown> | string, msg?: string): void;
  warn(obj: Record<string, unknown> | string, msg?: string): void;
  error(obj: Record<string, unknown> | string, msg?: string): void;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface RunContext {
  credential: SecretHandle | null;
  emit(e: AdapterEvent): void;
  signal: AbortSignal;
  sandbox: SandboxHandle;
  logger: Logger;
  /** The HTTP client. Injected so fixtures can replay vendor responses and so base URLs can be guarded. */
  fetch: FetchLike;
  /** Tools beyond the sandbox: search and the Brio mailbox. Absent ones are simply not offered to the model. */
  tools?: ToolProviders;
}

export type AdapterEvent =
  | { kind: "message"; role: "assistant" | "tool"; text: string }
  | { kind: "tool_call"; name: string; args: unknown }
  | { kind: "file_edit"; path: string; op: "create" | "modify" | "delete" }
  | {
      kind: "cost";
      usd: number;
      tokensIn?: number;
      tokensOut?: number;
      usage?: TokenUsage;
      model?: string;
      priceSource?: "vendor" | "table" | "free";
    }
  | { kind: "progress"; note: string }
  | { kind: "needs_input"; question: string };

export type RunStatus = "completed" | "failed" | "cancelled" | "limit_exceeded";

/** A file an agent produced outside the worktree: generated media, a hosted agent's outputs. */
export interface ProducedFile {
  kind: "image" | "video" | "audio" | "file";
  /** A display name (for the board and downloads). */
  name: string;
  contentType: string;
  bytes: Uint8Array;
  /** Where it belongs in the repository (the contract's output path); the runner places it in the worktree. */
  path?: string;
  /** What the vendor said about it: model, prompt, seed, duration… */
  meta?: Record<string, unknown>;
}

export interface RunResult {
  status: RunStatus;
  summary: string;
  /** Text output the orchestrator stores as an artifact (the agent's answer). */
  output: string;
  artifacts: AttachmentRef[];
  /** Files produced outside the worktree (media, hosted outputs): stored as artifacts by the runner. */
  files?: ProducedFile[];
  usage: { usd: number; tokensIn: number; tokensOut: number; seconds: number };
  /** Detailed usage across every call of the run. */
  tokens: TokenUsage;
  vendorRunId?: string;
  /** Why the run ended when it did not complete (shown to the user, stored as exit_reason). */
  error?: string;
  raw?: unknown;
}

export type HealthStatus =
  | { ok: true; latencyMs: number; detail?: string }
  | { ok: false; latencyMs: number; error: string; code: AdapterErrorCode };

export interface ModelInfo {
  id: string;
  displayName?: string;
  contextTokens?: number;
  maxOutputTokens?: number;
  /** Price per million tokens when the list endpoint reports it (OpenRouter, some gateways). */
  price?: ModelPrice;
  capabilities?: string[];
  createdAt?: string;
}

export type AdapterErrorCode =
  | "auth"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "bad_request"
  | "unavailable"
  | "network"
  | "timeout"
  | "cancelled"
  | "unsafe_url"
  | "misconfigured"
  | "invalid_response";

export interface AgentAdapter {
  key: string;
  route: Route;
  capabilities(config: AgentConfig): AdapterCapabilities;
  healthCheck(
    config: ConnectorConfig,
    ctx: Pick<RunContext, "credential" | "logger" | "fetch">,
  ): Promise<HealthStatus>;
  listModels?(config: ConnectorConfig, ctx: Pick<RunContext, "credential" | "fetch">): Promise<ModelInfo[]>;
  estimate(input: RunInput, config: AgentConfig): Promise<{ usd: number; minutes: number }>;
  run(input: RunInput, config: AgentConfig, ctx: RunContext): Promise<RunResult>;
  resume?(vendorRunId: string, message: string, ctx: RunContext): Promise<RunResult>;
}

// ---- Tools offered to API models by the internal tool loop -------------------------------------------------------

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface Tool extends ToolSpec {
  /** Returns text for the model. Throwing ends the call with an error result the model can read. */
  run(args: Record<string, unknown>, ctx: { signal: AbortSignal }): Promise<string>;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Web search for agents (ADAPTER_SPEC §2.9): the workspace's search connector (Exa, Tavily, Parallel, Brave). */
export interface SearchProvider {
  search(query: string, opts: { limit: number; signal: AbortSignal }): Promise<SearchResult[]>;
}

export interface FetchedPage {
  url: string;
  title: string;
  /** The page as Markdown (or plain text). */
  content: string;
  /** The page's own HTTP status, when the fetcher reports it. */
  status?: number;
}

/** Reads a web page for agents: the workspace's fetch connector (Firecrawl, Jina Reader). */
export interface FetchProvider {
  fetch(url: string, opts: { signal: AbortSignal }): Promise<FetchedPage>;
}

export interface InboxMessage {
  id: string;
  kind: string;
  /** Who sent it: a task key, or "user". */
  from: string;
  body: string;
}

/** The Brio mailbox (ADAPTER_SPEC §2.6): how an agent talks to the other agents of its mission and to the user. */
export interface Mailbox {
  /** Asks the agent working on another task; waits a while for the answer. */
  askAgent(taskKey: string, question: string): Promise<string>;
  /**
   * Asks a person (a hosted agent's question or approval request) and waits up to `waitMs` for the answer; null when
   * nobody answered in time (callers then fail closed: no answer is no approval).
   */
  askUser(question: string, opts?: { waitMs?: number }): Promise<string | null>;
  /** Questions and notes addressed to this task that have not been read yet; reading marks them read. */
  inbox(): Promise<InboxMessage[]>;
  answer(messageId: string, text: string): Promise<void>;
  reportBlocker(description: string): Promise<void>;
  requestReview(note: string): Promise<void>;
  reportProgress(note: string): Promise<void>;
  getContract(name: string): Promise<string>;
  /** The mission brief: goal, contracts and incoming handoffs (memory arrives in M9). */
  getBrief(): Promise<string>;
}

export interface CloudBrowserSession {
  /** The CDP WebSocket URL; may carry the vendor key, so it is never logged. */
  url: string;
  release(): Promise<void>;
}

/** Sessions on the workspace's cloud browser (Browserbase, Steel) for computer use. */
export interface CloudBrowserProvider {
  vendor: string;
  session(o: {
    width: number;
    height: number;
    timeoutS: number;
    signal: AbortSignal;
  }): Promise<CloudBrowserSession>;
}

export interface ToolProviders {
  search?: SearchProvider;
  fetch?: FetchProvider;
  browser?: CloudBrowserProvider;
  mailbox?: Mailbox;
}
