# Adapter Spec

Every connector is reached through one interface. Vendor quirks live only inside `packages/adapters/<family>/`.

## 1. Interface

```ts
// packages/adapters/src/types.ts
import type { TaskContract, HandoffPacket, MemoryBrief, AgentConfig, BrioEvent, Artifact } from "@brio/schema";

export type Route = "api" | "cli" | "sdk" | "hosted" | "a2a" | "mcp" | "browser" | "local";

export interface AdapterCapabilities {
  taskTypes: string[];                 // from the taxonomy in ROUTING_AND_QUALITY.md
  editsFiles: boolean;                 // works on a repo/worktree
  runsCode: boolean;                   // executes commands itself
  browses: boolean;
  producesMedia: ("image" | "video" | "audio")[];
  streaming: boolean;
  supportsMcpTools: boolean;           // can be given Brio mailbox + other MCP servers
  supportsResume: boolean;
  maxContextTokens?: number;
  runnerModes: ("cloud" | "local")[];
}

export interface RunInput {
  attemptId: string;
  taskTitle: string;
  instructions: string;                // rendered prompt (role + task + contract + constraints)
  contract: TaskContract;
  handoffs: HandoffPacket[];
  brief: MemoryBrief;
  workdir?: string;                    // worktree path inside sandbox (file-editing agents)
  attachments: Artifact[];
  limits: { maxCostUsd: number; maxMinutes: number; maxOutputTokens?: number };
  mcpServers: McpServerConfig[];       // always includes brio-mailbox for capable agents
}

export interface RunContext {
  credential: SecretHandle;            // resolved just-in-time from vault; never logged
  emit(e: AdapterEvent): void;         // streamed to orchestrator → BrioEvent
  signal: AbortSignal;                 // cancel / limit breach
  sandbox: SandboxHandle;              // exec, files, network policy
  logger: Logger;                      // redacting logger
  fetch: FetchLike;                    // outbound HTTP, behind the URL guard (D-32); fixtures replay through it
  tools?: { search?: SearchProvider; mailbox?: Mailbox };  // offered to API models only when present
}

export type AdapterEvent =
  | { kind: "message"; role: "assistant" | "tool"; text: string }
  | { kind: "tool_call"; name: string; args: unknown }
  | { kind: "file_edit"; path: string; op: "create" | "modify" | "delete" }
  | { kind: "cost"; usd: number; tokensIn?: number; tokensOut?: number }
  | { kind: "progress"; note: string }
  | { kind: "needs_input"; question: string };      // routed to mailbox / user

export interface RunResult {
  status: "completed" | "failed" | "cancelled" | "limit_exceeded";
  summary: string;                     // agent's own summary, goes into handoff packet
  artifacts: Artifact[];               // diffs are collected by runner from worktree; adapters add others
  usage: { usd: number; tokensIn: number; tokensOut: number; seconds: number };
  output: string;                      // the agent's text answer (stored as a report artifact)
  tokens: TokenUsage;                  // input / cached / cache-write / output / reasoning, summed over calls
  error?: string;                      // why it ended, when not completed
  vendorRunId?: string;                // for resume / audit
  raw?: unknown;                       // stored, never sent to other vendors
}

export interface AgentAdapter {
  key: string;                         // matches registry id, e.g. "cursor-agent"
  route: Route;
  capabilities(config: AgentConfig): AdapterCapabilities;
  healthCheck(connector: ConnectorConfig, ctx: Pick<RunContext, "credential" | "logger" | "fetch">): Promise<HealthStatus>;
  listModels?(connector: ConnectorConfig, ctx: Pick<RunContext, "credential" | "fetch">): Promise<ModelInfo[]>;
  estimate(input: RunInput, config: AgentConfig): Promise<{ usd: number; minutes: number }>;
  run(input: RunInput, config: AgentConfig, ctx: RunContext): Promise<RunResult>;
  resume?(vendorRunId: string, message: string, ctx: RunContext): Promise<RunResult>;
}
```

`ConnectorConfig` is the registry preset (D-27) plus the installed connector's base URL and API style. Health checks never spend money (D-31). The implementation is `packages/adapters/src/types.ts`.

Registration: `packages/adapters/src/index.ts` exports a map `key → AgentAdapter`. `packages/registry` validates that every P0/P1 registry entry with an implemented route has an adapter, and fails CI otherwise.

## 2. Adapter families

### 2.1 `openai-compatible` (route: api) — one adapter, many vendors
Covers any endpoint speaking OpenAI Chat Completions / Responses: OpenAI, xAI Grok (change base URL), Meta Model API (`muse-spark-1.1`), DeepSeek, Kimi, GLM, Qwen, Mistral (compat mode), Sarvam, OpenRouter, Together, Fireworks, Groq, Cerebras, LiteLLM proxy, Ollama/vLLM/LM Studio, Vercel/Cloudflare gateways.
- Config: `baseUrl`, `apiStyle` ("responses" | "chat"), `model`, `headers`, `supportsTools`, `supportsReasoningParam`.
- Implements an internal tool loop when the task needs tools (file read/write inside sandbox, search, Brio mailbox), so pure models can still act as agents.
- Pricing from a `pricing` table refreshed from provider docs/OpenRouter; cost event per response.

### 2.2 `anthropic` (route: api) and `gemini` (route: api)
Native APIs (called with `fetch`, D-28) for features compat layers lose: prompt caching, extended thinking, computer-use tool (Anthropic), long context and Interactions API (Gemini). Same internal tool loop as 2.1.

### 2.3 Coding CLIs (route: cli) — run official binaries headless inside the sandbox
All share a `CliAdapterBase`: spawn process in `workdir`, parse NDJSON/stream-json stdout into `AdapterEvent`s, enforce timeout, capture exit code, inject MCP config file, pass credentials via env only.

Cursor and Antigravity flags below were checked against 2026 sources on 23 Oct 2026; the rest are the commonly documented forms. Confirm every flag with `<binary> --help` before implementing.

| Adapter key | Binary & headless invocation | Auth in cloud runner | Notes |
|---|---|---|---|
| `claude-code` | `claude -p "<prompt>" --output-format stream-json` (or Claude Agent SDK in-process: `@anthropic-ai/claude-agent-sdk`) | `ANTHROPIC_API_KEY` | Prefer the Agent SDK for structured events. Subscription limits are not allowed for third-party agents; use API keys. Hooks file can enforce Brio leases on writes. |
| `codex` | `codex exec "<prompt>" --json` (or Codex SDK, TypeScript) | `OPENAI_API_KEY` | API-key mode runs locally only; Codex Cloud tasks need the user's ChatGPT plan → model it as a separate `codex-cloud` hosted adapter, local-runner only. |
| `cursor-agent` | `cursor agent -p --trust --output-format stream-json "<prompt>"`; `--force` for unattended edits; `-w <name>` worktree; `--approve-mcps` | `CURSOR_API_KEY` | `-p` and `--trust` are mandatory headless or it hangs. Supports ACP. |
| `antigravity` | `agy -p "<prompt>" --output-format stream-json --non-interactive [--model <id>]` | Antigravity SDK with API key/Vertex in cloud; `agy` signed in by the user only in local runner | Can serve Claude and GPT-OSS models too. Known headless issue: permissions allowlist ignored and denied runs report success (issue #548) → always verify via diff + checks, set explicit tool profile. Never copy agy's OAuth token file. |
| `opencode` | `opencode run "<prompt>" --format json` | any provider key | Model-agnostic; good default for cheap open models. |
| `aider` | `aider --message "<prompt>" --yes` | provider key | Non-streaming; parse final output + git diff. |
| `goose` | `goose run -t "<prompt>"` | provider key | |
| `copilot-cli` | GitHub Copilot CLI non-interactive mode | GitHub token with Copilot seat | Verify flags at build time. |
| `grok-build` | Grok Build CLI | xAI key | Availability was waitlisted in spring 2026; implement when GA. |
| `kiro-cli`, `qwen-code`, `kimi-cli`, `cline-cli`, `amp`, `droid`, `junie`, `warp` | each vendor's headless flag | vendor key | P2; same base class. |

Lease enforcement for CLIs: generate the agent's own hook config (Claude Code `.claude/settings.json` PreToolUse, Cursor `.cursor/hooks.json`, Codex `.codex/hooks.json`, Antigravity `.agents/hooks.json`) that calls the local runner's lease endpoint before writes — the same mechanism Relay uses, but checking task leases and contracts.

### 2.4 Hosted agent APIs (route: hosted) — vendor runs the sandbox
Pattern: create session/task → stream or poll events → fetch outputs (diff, PR URL, files) → map to artifacts.

| Adapter key | API (verified 23 Oct 2026) | Notes |
|---|---|---|
| `claude-managed-agents` | Claude Platform REST, beta header `managed-agents-2026-04-01` | Built-in tools: files, shell, web, code. Not ZDR/HIPAA eligible yet → policy may block for sensitive projects. |
| `openai-agents` | `POST /v1/agents/sessions`, header `OpenAI-Beta: agents=v1`; events incl. `agent.session.requires_action` | Hosted browser (since 29 Sep 2026): Brio must answer site-access and sign-in approval requests → route to `approvals`. |
| `gemini-managed-agents` | Gemini Interactions API (preview) | Persistent sandboxes, saved agents, triggers, budgets, remote MCP. |
| `jules` | Jules REST API v1alpha (sessions, activities, approve plan, messages, outputs) | GitHub repos only; output is a PR → treat as diff artifact. |
| `devin` | Devin API (sessions) | Output PRs/messages. |
| `manus` | Manus API (tasks, projects, connectors, webhooks) | Webhook endpoint in `apps/api` for completion. |
| `bedrock-agentcore` | AgentCore Runtime invoke + managed harness | For AWS-hosted customer agents. |
| `foundry-agents` | Foundry Agent Service (Responses API format) | For Microsoft customers. |
| `codex-cloud` | Codex Cloud tasks | ChatGPT-plan auth → local runner, user-initiated only; verify allowed programmatic access before shipping. |

### 2.5 A2A (route: a2a)
- Discover: fetch Agent Card (`/.well-known/agent-card.json`), store skills, auth scheme, streaming support.
- Map skills → task types (planner-assisted mapping stored on the connector; user can edit).
- Send `message/send` or streaming `message/stream`; track A2A task id; map parts/artifacts to Brio artifacts; support input-required state → mailbox/approvals.
- Use the official A2A JS SDK; protocol v1.0 (Mar 2026).

### 2.6 MCP (route: mcp)
MCP servers are **tools**, not agents. Attach them to agents via `RunInput.mcpServers`. Brio ships its own MCP servers:
- `brio-mailbox` (ask_agent, answer, report_blocker, request_review, get_contract, get_brief, report_progress) — injected into every capable agent.
- `brio-lease` (claim, release, status) — used by hooks and agents that prefer explicit claims.

### 2.7 Browser / computer use (route: browser via sdk/hosted)
- `anthropic-computer-use` (Messages API tool, our sandboxed browser VM), `openai-agents` hosted browser, `nova-act` (SDK), `browser-use` (library or cloud API), cloud browsers (Browserbase/Steel) as infrastructure.
- Always behind `browser` sandbox profile with per-task URL allowlist; credentials for sites never typed by agents — use approvals + user-side sign-in handoff.

### 2.8 Media (route: api)
`openai-image`, `google-media` (Veo / current image models), `flux`, `runway`, `luma`, `kling`, `elevenlabs`, `ideogram`, `recraft`. Async job pattern (submit → poll/webhook → download → artifact with spec metadata: size, duration, format). Verifier runs spec checks and an optional vision-model review.

### 2.9 Research tools (route: api/mcp)
Search APIs (Exa, Tavily, Parallel, Brave), Perplexity Agent API, OpenAI search models, Grok live search, page fetchers. Exposed to agents as MCP tools from `packages/adapters/research` so every agent gets the same search surface (makes results comparable for judging).

## 3. Explicitly unsupported (adapters must not exist)
Midjourney (no official API), Suno/Udio wrappers, Perplexity Comet driving, ChatGPT/Claude/Gemini/Grok consumer web apps, Genspark/Kimi/MiniMax consumer agents, any adapter that reads another app's stored tokens. `packages/registry` marks these `route: none` and the UI shows "not supported — here's the legitimate alternative".

## 4. Adapter test kit
Each adapter ships:
- Unit tests for event parsing using recorded fixtures (`__fixtures__/*.ndjson`).
- A contract test suite (`packages/adapters/test/contract.ts`) every adapter must pass: health check, estimate, run "hello task" in sandbox, cancel mid-run, limit breach, credential redaction (assert secret never appears in events/logs).
- Live tests gated by env vars (`LIVE_<KEY>=1`) run nightly, not in PR CI.

## 5. Adding a new connector (checklist)
1. Add/verify entry in `registry/connectors.json` (route, auth, docs URL, verified date).
2. Pick family base class; implement `AgentAdapter`.
3. Record fixtures; pass contract suite.
4. Add pricing entries; add to router candidate pool with prior scores (Beta(1,1)).
5. Add setup steps to the connector page copy.
