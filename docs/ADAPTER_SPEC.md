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

Every flag below was checked against the CLI's own `--help` inside the sandbox image on 23 Oct 2026 (versions in D-36). Implementations: `packages/adapters/src/cli/`.

| Adapter key | Headless invocation (as implemented) | Key (env) | Notes |
|---|---|---|---|
| `claude-code` | `claude -p --output-format stream-json --verbose --permission-mode bypassPermissions --model <m> --max-turns <n> --max-budget-usd <usd> --setting-sources "" --strict-mcp-config --no-session-persistence` (prompt on stdin) | `ANTHROPIC_API_KEY` | Reports cost. `is_error`, not `subtype`, signals failure. Bypass mode refuses root (sandboxes are non-root). D-42 |
| `codex` | `codex exec --json --skip-git-repo-check --ephemeral --dangerously-bypass-approvals-and-sandbox --model <m> --cd /work -c check_for_update_on_startup=false -c analytics.enabled=false <prompt>` | `CODEX_API_KEY` | Tokens per turn, no cost (priced from the OpenAI table). Only `turn.failed` is fatal. Needs ca-certificates |
| `cursor-agent` | `cursor-agent -p --output-format stream-json --force --trust --approve-mcps --sandbox disabled --workspace /work --model <m> <prompt>` | `CURSOR_API_KEY` | `-p --trust` or it hangs; `--force` or it only proposes. No usage or cost: unmetered (D-37). Commit attribution turned off |
| `antigravity` | `agy -p <prompt> --output-format stream-json --dangerously-skip-permissions --model <m> --print-timeout <n>m --add-dir /work` | `GEMINI_API_KEY` + settings `{"modelProvider":"gemini"}` | Exit status untrusted (issue 548): the result event, diff and checks decide. API-key mode, so it also runs in cloud sandboxes; a user's signed-in `agy` is for the local runner only (M8), and its OAuth token is never copied |
| `opencode` | `opencode run --format json --auto --pure --model openrouter/<m> --dir /work <prompt>` | `OPENROUTER_API_KEY` | Cost per step |
| `aider` | `aider --model anthropic/<m> --message <prompt> --yes-always --no-auto-commits --no-attribute-author …` | `ANTHROPIC_API_KEY` | No structured output: text lines, its session-cost line, and the runner's diff |
| `goose` | `goose run --no-session --quiet --output-format stream-json --provider anthropic --model <m> --max-turns <n> --no-profile --with-builtin developer --text <prompt>` | `ANTHROPIC_API_KEY` | Repo moved to aaif-goose/goose; cost in the `complete` event |
| `copilot-cli`, `grok-build`, `kiro-cli`, `qwen-code`, `kimi-cli`, `cline-cli`, `amp`, `droid`, `junie`, `warp` | each vendor's headless flag | vendor key | Later (P1/P2); same base |

Prompts longer than 100 KB go to the agent as `.brio/prompt.md` (one argv element is capped at 128 KiB). Keys reach the CLI only through a 0600 env file read by `docker exec`, never argv. Each CLI's vendor host is its only egress besides package registries and git (D-39).

Lease enforcement for CLIs: generate the agent's own hook config (Claude Code `.claude/settings.json` PreToolUse, Cursor `.cursor/hooks.json`, Codex `.codex/hooks.json`, Antigravity `.agents/hooks.json`) that calls the local runner's lease endpoint before writes — the same mechanism Relay uses, but checking task leases and contracts.

### 2.4 Hosted agent APIs (route: hosted) — vendor runs the sandbox
Pattern: create session/task → stream or poll events → fetch outputs (diff, PR URL, files) → map to artifacts. As implemented (M6): every service connector is registry data (`services` in `registry/connectors.json`: base URL with settings, auth scheme incl. SigV4 and Entra, a free key check, the billing unit, the task types it takes; D-62), and every vendor is one `JobVendor` (start, poll, answer, cancel, outputs) on the shared job runner in `packages/adapters/src/services/job.ts`. Questions and approvals go to a person through the mailbox (10 minutes; no answer is no; D-64). Changes come back as a patch applied to the task's own worktree. Wire facts per vendor: `docs/vendors/hosted-agents.md`.

| Adapter key | API (verified 23 Oct 2026) | Notes |
|---|---|---|
| `claude-managed-agents` | Claude Platform REST, beta header `managed-agents-2026-04-01` | Built-in tools: files, shell, web, code. Not ZDR/HIPAA eligible yet → policy may block for sensitive projects. |
| `openai-agents` | `POST /v1/agents/sessions`, header `OpenAI-Beta: agents=v1`; events incl. `agent.session.requires_action` | Hosted browser (since 29 Sep 2026): Brio must answer site-access and sign-in approval requests → route to `approvals`. |
| `gemini-managed-agents` | Gemini Interactions API (preview) | Persistent sandboxes, saved agents, triggers, budgets, remote MCP. |
| `jules` | Jules REST API v1alpha (sessions, activities, approve plan, messages, outputs) | GitHub repos only; output is a PR → treat as diff artifact. |
| `devin` | Devin API (sessions) | Output PRs/messages. |
| `manus` | Manus API (tasks, projects, connectors, webhooks) | Polled; with a public https Brio, a webhook (`/v1/hooks/manus/:connectorId`, RSA-signed) adds a board note at once (D-72). |
| `bedrock-agentcore` | AgentCore Runtime invoke + managed harness | For AWS-hosted customer agents. |
| `foundry-agents` | Foundry Agent Service (Responses API format) | For Microsoft customers. |
| `codex-cloud` | Codex Cloud tasks | ChatGPT-plan auth → local runner, user-initiated only; verify allowed programmatic access before shipping. |

### 2.5 A2A (route: a2a)
- Discover: fetch Agent Card (`/.well-known/agent-card.json`), store skills, auth scheme, streaming support.
- Map skills → task types (planner-assisted mapping stored on the connector; user can edit).
- Send `message/send` or streaming `message/stream`; track A2A task id; map parts/artifacts to Brio artifacts; support input-required state → mailbox/approvals.
- Use the official A2A JS SDK; protocol v1.0 (Mar 2026).
- As implemented (M7): registry service `a2a` (URL setting, optional bearer); the card is read at install, its skills suggest task types (editable), each agent is its own vendor by host, runs are unmetered (D-79).

### 2.6 MCP (route: mcp)
MCP servers are **tools**, not agents. Attach them to agents via `RunInput.mcpServers`. Brio ships its own MCP servers:
- `brio-mailbox` (ask_agent, inbox, answer, report_blocker, request_review, get_contract, get_brief, report_progress) — given to every capable agent: in-process for model-API agents (new messages arrive between turns), and as a streamable-HTTP MCP server for coding CLIs, reached through the sandbox's proxy at `brio-mailbox:8080` with a per-attempt token (D-43). Claude Code, Codex, Cursor and OpenCode are configured for it; Antigravity, Goose and Aider run without it for now.
- `brio-lease` (claim, release, status) — used by hooks and agents that prefer explicit claims.
- As implemented (M7): any remote MCP server installs as registry service `mcp` and attaches to agents as a tool (D-80); model-API agents call its tools in their tool loop; coding CLIs get it in their MCP configuration.

### 2.7 Browser / computer use (route: browser via sdk/hosted)
- `anthropic-computer-use` (Messages API tool, our sandboxed browser VM), `openai-agents` hosted browser, `nova-act` (SDK), `browser-use` (library or cloud API), cloud browsers (Browserbase/Steel) as infrastructure.
- Always behind `browser` sandbox profile with per-task URL allowlist; credentials for sites never typed by agents — use approvals + user-side sign-in handoff.
- As implemented (M6): `anthropic-computer-use` drives Chromium on a virtual display in the `sandbox-browser` image with xdotool and screenshots; the allowlist is the hosts the contract names (D-69). With `options.browser = "cloud"` it drives a Browserbase or Steel session over CDP instead, the allowlist enforced in the browser (D-70). `browser-use` runs Browser Use Cloud v4, capped at the attempt's budget (D-71).

### 2.8 Media (route: api)
`openai-image`, `openai-speech`, `google-media` (Gemini Omni video and Nano Banana images through the Interactions API; Veo left the Gemini API on 22 Oct 2026), `flux`, `runway`, `luma`, `kling`, `elevenlabs`, `ideogram`, `recraft`. Async job pattern (submit → poll/webhook → download → artifact with spec metadata: size, duration, format). Verifier runs spec checks and an optional vision-model review. As implemented (M6): the size, aspect, duration and format asked for come from the task's media_spec check; results are downloaded at once and placed at the contract's output path; voice reads a script file the contract names, never the instructions; metering in the vendor's unit (D-65). Wire facts: `docs/vendors/media.md`.

### 2.9 Research tools (route: api/mcp)
Search APIs (Exa, Tavily, Parallel, Brave), Perplexity Agent API, OpenAI search models, Grok live search, page fetchers. Exposed to agents as MCP tools from `packages/adapters/research` so every agent gets the same search surface (makes results comparable for judging). As implemented (M6): search and fetch services are workspace tools, not agents — `web_search` and `fetch_url` in-process for model APIs and on the brio-mailbox MCP server for coding CLIs, metered per call, never on confidential tasks (D-66). Perplexity's Agent API, OpenAI's Responses web search and xAI's web and X search are research agents that answer with a numbered source list; Gemini Deep Research runs as a managed agent. Wire facts: `docs/vendors/research-browser.md`.

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
