# Build Plan

The full product, built in dependency order. Each milestone ends production-grade (see Definition of Done in CLAUDE.md). Milestones marked ∥ can run in parallel sessions/worktrees once their dependencies are done — Brio itself will later orchestrate this kind of parallel build.

Status column: update as you go (`todo` / `in progress` / `done (commit sha)`).

| # | Milestone | Depends on | Status |
|---|---|---|---|
| M0 | Foundation: monorepo, CI, DB, auth, workspaces, vault, events | — | done (23 Oct 2026, pushed in 10 steps; see CHANGELOG) |
| M1 | Connector framework, registry loader, model-API adapters, metering | M0 | done (23 Oct 2026, pushed in steps; live vendor runs await owner keys, see CHANGELOG) |
| M2 | Sandboxed runner + coding-CLI adapters | M1 | done (23 Oct 2026, pushed in steps; live CLI runs await owner keys, see CHANGELOG) |
| M3 | Missions, planner, task DAG engine, contracts, leases, handoffs, mailbox | M1 (M2 for code tasks) | done (23 Oct 2026, pushed in steps; live golden run awaits owner keys, see CHANGELOG) |
| M4 ∥ | Router, execution modes, scoreboard | M3 | done (23 Oct 2026, pushed in steps; live golden run awaits owner keys, see CHANGELOG) |
| M5 ∥ | Verifier, judge, merge, eval harness | M3 | done (23 Oct 2026, pushed in steps; live evals await owner keys, see CHANGELOG) |
| M6 ∥ | Hosted-agent, browser, media and research adapters | M2 | done (24 Oct 2026, pushed in steps; live vendor runs await owner keys, see CHANGELOG) |
| M7 ∥ | Protocol surfaces: Brio MCP server, A2A server + client, ACP | M3 | done (24 Oct 2026, pushed in steps; live client connections await a public deployment, see CHANGELOG) |
| M8 | Web app complete + CLI + local runner | M3–M7 | done (24 Oct 2026, pushed in steps; a real signed-in CLI on the owner's machine and github.com pull requests await the owner, see CHANGELOG) |
| M9 | Governance complete, memory graph, notifications, orgs/RBAC | M3, M8 | done (24 Oct 2026, pushed in steps; live email, push, Slack and Mandate await the owner's keys and apps, see CHANGELOG) |
| M10 | Self-host packaging, hardening, docs site, launch readiness | all | done (24 Oct 2026, pushed in steps; see CHANGELOG, SECURITY_REVIEW and LOAD_TEST) |

---

## M0 — Foundation
**Goal:** a running skeleton every later milestone plugs into.

Deliverables
- pnpm + Turborepo monorepo with the layout in CLAUDE.md; Biome; strict tsconfig base; Vitest; Playwright scaffold.
- `packages/schema`: Zod schemas for Workspace, Member, Connector, Agent, Project, Mission, Plan, Task, TaskContract, Attempt, Artifact, Review, Contract, Lease, Message, HandoffPacket, Event, Budget, Policy, Approval, LedgerEntry.
- `packages/db`: Drizzle schema for every table in ARCHITECTURE §3; migrations; seed script (demo workspace, demo project).
- `apps/api`: Fastify with health, auth (Better Auth: Google, magic link, passkeys, organisations), workspace CRUD, SSE endpoint streaming `events` by mission with `Last-Event-ID` resume.
- `packages/brand`: copy `brand/tokens.css`, `brand/tailwind.preset.ts` and `brand/logo/*`; Geist fonts via the `geist` package; shadcn/ui variables mapped to Brio tokens (see `brand/BRAND.md` §6).
- `apps/web`: Next.js shell in the Brio brand (dark default, light toggle), `brio_` wordmark in the header with the cursor blinking while anything is running, favicon/app icons/OG image wired into metadata, sign-in, workspace switcher, empty states for Missions, Connectors, Agents, Scoreboard, Settings.
- `packages/vault`: envelope encryption, KMS abstraction (local key provider + AWS KMS provider), redactor utility with tests.
- Events writer with per-mission `seq` (transactional), ledger table with hash chain + trigger blocking UPDATE/DELETE.
- Docker Compose for local Postgres (with pgvector); `pnpm dev` runs everything.
- CI: install, typecheck, lint, unit tests, migration-on-empty-DB check.

Acceptance
- Sign in, create workspace, invite member (email logged locally), switch workspace.
- `POST /missions` (stub planner returning a one-task plan) writes events; web board shows them live via SSE; reconnect resumes without gaps.
- Vault round-trips a secret; redactor test proves a planted secret never appears in logs/events.
- Ledger chain verifies; tampering test fails verification.
- Web shell matches `brand/BRAND.md`: correct logo, favicon, fonts, dark/light themes; no hard-coded colours outside `packages/brand` (lint rule or test).

## M1 — Connectors and model APIs
**Goal:** Brio can call any major model safely and meter it.

Deliverables
- `packages/registry`: load + validate `registry/connectors.json`; capability lookup by task type; CI check that implemented routes have adapters.
- `packages/adapters` core: `AgentAdapter` types, contract test suite, redacting logger, `openai-compatible` family (Responses + Chat), `anthropic`, `gemini` native adapters with internal tool loop (sandbox file tools stubbed until M2, search tool, mailbox tool interface).
- Presets for: OpenAI, Anthropic, Google, xAI, Meta Model API, Mistral, DeepSeek, Kimi, GLM, Qwen, Sarvam, OpenRouter, LiteLLM, Ollama/vLLM, Groq, Together, Fireworks.
- Live model listing per connector; pricing table + updater; cost events per call.
- Connector UI: catalogue (grouped by the 13 categories, route chips, status, tier), add connector (BYOK key → vault), health check, model list.
- Agent builder UI: connector + model + role prompt + limits.

Acceptance
- Add keys for ≥4 vendors; health checks pass; models listed live.
- Run a one-task mission against each preset; cost recorded per attempt matches provider usage within 2%.
- Contract suite green for every implemented adapter (fixtures); live tests runnable with env flags.

## M2 — Runner and coding CLIs
**Goal:** coding agents run safely in sandboxes and produce diffs.

Deliverables
- `apps/runner`: pg-boss consumer; sandbox manager (Docker): profiles from ARCHITECTURE §5, egress allowlist, limits, teardown; git worktree per attempt; artifact collection (diff, files) with sha256; heartbeat + reaper.
- Sandbox images with official CLIs installed: Claude Code / Agent SDK, Codex CLI/SDK, Cursor Agent CLI, OpenCode, Aider, Goose (Antigravity: SDK path in cloud; `agy` only in local runner).
- `CliAdapterBase` (spawn, NDJSON parse, timeout, cancel, MCP config injection, hook config generation for lease checks).
- Adapters: `claude-code`, `codex`, `cursor-agent`, `antigravity`, `opencode`, `aider`, `goose`.
- File tools for API-model agents (read/write/list/run inside sandbox) so pure models can code too.

Acceptance
- Same coding task ("add a function + unit test" in a fixture repo) completes with each CLI adapter; diff artifact produced; tests pass inside sandbox.
- Cancel mid-run kills process and container within 10 s; limit breach ends with `limit_exceeded`.
- Network test: sandbox cannot reach a non-allowlisted host.
- Secrets never appear in transcripts (contract test).

## M3 — Missions, planner, DAG engine, coordination
**Goal:** a mission becomes a plan, runs as a graph, and agents coordinate.

Deliverables
- Planner (ROUTING §2) with structured output, contract-first pass, footprint inference from repo map, estimates, plan lint; clarifying questions (≤3).
- Plan editor API (reorder, split, merge, reassign, pin, budget, gates); plan versions.
- Scheduler: idempotent run state machine (ARCHITECTURE §4.2) over pg-boss; resumable after crash.
- Lease manager (task-level, heartbeat, expiry, overlap → block or split), contract registry with versioning and `contract.changed` propagation.
- Handoff packet generation (HANDOFF_PACKET.md) and injection (`.brio/handoff.json` + prompt section).
- Mailbox: `brio-mailbox` MCP server (stdio for sandbox, HTTP for remote) — ask_agent, answer, report_blocker, request_review, get_contract, get_brief, report_progress.
- Temporary static router (capability + user pin) until M4.

Acceptance
- Golden mission "Add OAuth login + tests to sample Next.js app" plans into ≥4 tasks incl. a contract task; runs end to end with two different vendors in parallel; no lease overlap; handoffs present.
- Kill the API mid-mission; restart; mission resumes and completes.
- An agent's `ask_agent` question reaches the other running task and the answer comes back (event trail visible).

## M4 ∥ — Router, modes, scoreboard
Deliverables
- Router (ROUTING §3): candidate filtering (capability, policy, health, budget), Thompson sampling with cost/latency utility, rationale string.
- Modes: single, best_of_n, ensemble, maker_checker, debate, cascade, pipeline (with mode params).
- Scoreboard tables + updates (α/β, Elo, cost/latency EMA, decay, new-model priors); scoreboard UI (filters by task type, vendor; trend).

Acceptance
- Simulation tests: with synthetic agents of known quality/cost, router converges to the best utility agent within 50 tasks per type.
- Each mode has an integration test with fake adapters and one live golden mission.
- Every routed task shows a one-line rationale on the board.

## M5 ∥ — Verifier, judge, merge, evals
Deliverables
- Check runners for all kinds in ROUTING §4.1; rubric reviewer (cross-vendor enforced); fact checker; media spec checks.
- Verdict logic with revise loop and reroute; judge with order-swapped pairwise comparison.
- Merge engine: DAG-order integration branch; conflict → `merge.integrate` task; verification after merge.
- Mission report generator (what, who, evidence, cost, time, open issues).
- `apps/evals`: 30 golden missions with scorers; baselines (single agents) vs Brio static vs learned; nightly CI job; results dashboard page.

Acceptance
- A seeded-bug repo: wrong fix is caught by tests → revise → fixed by second attempt or rerouted agent.
- Rubric reviewer is never the maker's vendor (property test).
- Eval run produces comparable metrics table; PRD metric (≥15-point lift at ≤1.3× cost) is measurable.

## M6 ∥ — Hosted, browser, media, research adapters
Deliverables
- Hosted: `claude-managed-agents`, `openai-agents` (incl. hosted browser `requires_action` → approvals), `gemini-managed-agents`, `jules`, `devin`, `manus` (webhook receiver), `bedrock-agentcore`, `foundry-agents`.
- Browser: `anthropic-computer-use` (our browser sandbox), `nova-act`, `browser-use`, cloud browser provider abstraction (Browserbase/Steel).
- Media: `openai-image`, `google-media`, `flux`, `runway`, `luma`, `kling`, `elevenlabs`, `ideogram`, `recraft` (async job pattern).
- Research tools as shared MCP: Exa, Tavily, Parallel, Brave, Perplexity Agent API, Grok live search, page fetcher.
- Unsupported-connector UX (Midjourney, Suno, Comet, consumer apps) with legitimate alternatives.

Acceptance
- Each adapter passes contract suite with fixtures; at least one live run each where keys available.
- Golden mission "Landing page + hero image + 30-s voiceover" uses ≥3 vendors across code/media/voice and passes verification.

## M7 ∥ — Protocol surfaces
Deliverables
- Brio MCP server (remote, OAuth 2.1 consent; local stdio): `delegate`, `plan_mission`, `ask_agent`, `get_brief`, `report`, `get_contract`, `request_review`, `mission_status`.
- A2A server: Agent Card at `/.well-known/agent-card.json`, skills, task lifecycle, streaming, artifacts, auth.
- A2A client adapter (ADAPTER_SPEC §2.5) incl. skill→task-type mapping UI.
- ACP support in CLI adapter base where the agent supports it (Cursor first).

Acceptance
- From inside Claude Code, a user calls `brio.delegate` to have a Gemini agent research and a Codex agent write tests; results return to Claude Code.
- An external A2A client (official SDK sample) sends a mission to Brio and receives artifacts.
- Brio delegates a task to an external A2A agent (sample agent) and verifies its output.

## M8 — Web app complete, CLI, local runner
Deliverables
- Web (all surfaces follow `brand/BRAND.md`; the live board is the hero screen): mission composer (text, files, repo, issue link); plan editor (graph + list); live board (tasks, agents, leases, messages, costs, verdicts, diffs viewer); approvals inbox; scoreboard; connectors & agents; crews; templates; mission report page; settings.
- CLI: `brio login`, `brio run`, `brio plan`, `brio board` (TUI), `brio approve`.
- Local runner daemon (`brio runner`): outbound WebSocket to API, executes `local` jobs with locally installed CLIs (incl. `agy`, Codex Cloud hand-off), same sandbox rules via local Docker or a restricted mode with explicit user consent.

Acceptance
- Playwright e2e: create mission → edit plan → approve → watch live → approve PR action → read report.
- Local runner runs a task in a local repo using a locally signed-in CLI, with events visible in the web board.

## M9 — Governance, memory, notifications, orgs
Deliverables
- Budgets at all scopes with pre-dispatch checks and live stop; policy engine (data routing, network, approvals, connector allow-lists); approvals across web/email/Slack/push/MCP; ledger UI + verifier; optional Mandate connection (D-07).
- Memory graph ingest from events; `get_brief`; memory UI (view/edit/forget).
- Notifications (email via Resend, Slack app, web push).
- Org roles and permissions enforced everywhere; audit export.
- Decide D-14 (global scoreboard) and implement if yes.

Acceptance
- Confidential task can never be routed to a disallowed connector (property tests + e2e).
- Budget stop halts a running attempt within 5 s of crossing.
- Brief for a file includes the decisions, contracts and prompts behind its recent changes.

## M10 — Self-host, hardening, launch
Deliverables
- Helm chart + Docker Compose self-host bundle; env reference; backup/restore guide.
- Security review: threat model, dependency audit, sandbox escape tests, prompt-injection test suite.
- Load test: 100 concurrent missions, 500 concurrent attempts.
- Docs site (getting started, connectors, adapters SDK for community adapters, API reference).
- Billing hooks (if D-15 decided), usage analytics, status page.

Acceptance
- Fresh self-host install from docs in < 30 minutes.
- Load test SLOs met (API p95 < 300 ms; event fan-out < 1 s).
- Pen-test findings: no high/critical open.
