# CLAUDE.md — Brio

Project memory for Claude Code. Read this first in every session, then the doc in `docs/` that matches the task.

## What we are building

**Brio** is a multi-agent orchestrator. A user gives one goal ("a mission"). Brio:

1. **Plans** it into a graph of tasks with explicit contracts.
2. **Routes** each task to the best agent or model across vendors — Claude Code, Codex, Cursor, Antigravity, Grok, Gemini, GPT, Muse Spark, open models, hosted agents (Claude Managed Agents, OpenAI Agents API, Jules, Devin, Manus), browser agents, media models, and any A2A agent.
3. **Coordinates** the agents while they work: task leases, interface contracts, handoff packets, shared memory, agent-to-agent messages.
4. **Verifies** results across vendors (tests, typecheck, cross-model review, judge) before a human sees them.
5. **Learns** which agent wins at which task type, at what cost and speed, and feeds that back into routing.
6. **Governs** everything: budgets, approvals, audit, secrets.

It is the conductor, not another agent. See `docs/PRD.md`.

This build pack was written in a Claude chat session and handed to Claude Code. That hand-off is itself Brio's core use case: planning in one agent, building in another, with a structured packet between them (`docs/HANDOFF_PACKET.md`). Keep that in mind; we dogfood the format.

## Read order

| When you are… | Read |
|---|---|
| Starting any work | this file, then `docs/BUILD_PLAN.md` (find the current milestone) |
| Touching product behaviour | `docs/PRD.md` |
| Touching structure, data, services | `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` |
| Writing any connector or adapter | `docs/ADAPTER_SPEC.md`, `registry/connectors.json`, `docs/CONNECTORS.md` |
| Planner, router, scoring, verification | `docs/ROUTING_AND_QUALITY.md` |
| Keys, sandboxes, approvals, budgets, ToS | `docs/SECURITY_GOVERNANCE.md` |
| Handoffs between agents | `docs/HANDOFF_PACKET.md` |
| Any UI, logo, colours, fonts, copy | `brand/BRAND.md`, `brand/tokens.css`, `brand/tailwind.preset.ts` |

## Stack (decided — see `docs/DECISIONS.md` before changing)

- **Language:** TypeScript everywhere (strict). Node 22 LTS.
- **Monorepo:** pnpm workspaces + Turborepo.
- **Web app:** Next.js (App Router), Tailwind, shadcn/ui. Deployed on Vercel.
- **API + orchestrator service:** Fastify. Long-running, deployed as a container (Fly.io or any Docker host). Never on serverless.
- **Workers / runners:** Docker containers, one sandbox per task attempt, git worktree per attempt.
- **Database:** Postgres (Neon in cloud, plain Postgres for self-host) + Drizzle ORM + drizzle-kit migrations. `pgvector` for embeddings.
- **Queue + durable runs:** `pg-boss` on Postgres plus our own persisted run state machine (no extra infra).
- **Realtime:** Server-Sent Events from the API to the web app.
- **Auth:** Better Auth (Google, email magic link, passkeys, organisations). MCP OAuth 2.1 for agents connecting to Brio.
- **Validation:** Zod at every boundary. Shared schemas in `packages/schema`.
- **Protocols:** `@modelcontextprotocol/sdk` (MCP), the official A2A JS SDK (verify current package name on npm before installing), ACP for driving coding CLIs where supported.
- **Tests:** Vitest (unit/integration), Playwright (web e2e), a golden-mission eval harness (`apps/evals`).
- **Lint/format:** Biome.

## Repo layout (target)

```
apps/
  web/            Next.js app: missions, plan editor, live board, diffs, approvals, scoreboard, connectors, budgets
  api/            Fastify: REST + SSE + MCP server + A2A server; hosts orchestrator loop
  runner/         Sandbox worker: pulls attempts from queue, runs adapters inside Docker
  cli/            `brio` CLI (run missions, tail boards, local runner mode)
  evals/          Golden-mission benchmark harness
packages/
  schema/         Zod schemas + TS types shared by all (Mission, Task, Contract, HandoffPacket, Event…)
  db/             Drizzle schema, migrations, query helpers
  core/           Planner, router, scheduler, lease manager, verifier, scoreboard (pure logic, no I/O where possible)
  adapters/       One folder per connector family; all implement AgentAdapter (docs/ADAPTER_SPEC.md)
  registry/       Loads registry/connectors.json, validates, exposes capability lookup
  vault/          BYOK secret storage (envelope encryption)
  governance/     Budgets, policies, approvals, audit ledger (Mandate-compatible)
  memory/         Project memory graph (Postgres tables + pgvector)
  sdk/            Public TS client for Brio's own API
  brand/          Logo files, tokens.css, Tailwind preset (copied from /brand in M0)
registry/
  connectors.json Machine-readable connector registry (source of truth for adapters)
brand/            Source brand assets and guide (BRAND.md)
```

## Non-negotiable rules

1. **No consumer-UI scraping, no token reuse.** Never automate chatgpt.com, claude.ai, gemini.google.com, grok.com, or any consumer chat app. Never read or reuse OAuth/session tokens that an official CLI stored. Only: official APIs with the user's own keys (BYOK), official CLIs invoked as documented, official SDKs, hosted agent APIs, A2A/MCP endpoints. Details in `docs/SECURITY_GOVERNANCE.md`.
2. **Every adapter goes through `AgentAdapter`.** No vendor-specific calls outside `packages/adapters`.
3. **Every agent action is an event.** Append-only `events` table; UI and scoring read from events. No silent side effects.
4. **Every task has a contract** (inputs, outputs, acceptance checks) before it is dispatched.
5. **Sandbox by default.** Agents that execute code run in a container with a scoped worktree, network allowlist, CPU/mem/time limits. Never on the API host.
6. **Money and irreversible actions go through governance.** Budgets checked before dispatch; irreversible actions (push, deploy, send, purchase, delete) need an approval policy.
7. **Secrets never in logs, prompts to third-party models, or events.** Redact at the adapter boundary.
8. **Model names are data, not code.** Pull live model lists from providers; never hard-code a "latest" model.
9. **Git:** commit with clear messages per task, split into small steps. Push only to `origin` (github.com/Ivan825/brio_) and only as the owner's logged-in account (**Ivan825**), when the owner has authorised pushing for the current milestone and checks are green. Never create remote repos. No bot, GitHub App or AI identity touches the repo: no AI co-author trailers, no "Generated with" lines, no AI-driven GitHub Actions (D-17).
10. **Use the Brio brand everywhere.** Logo, colours, fonts and UI style come only from `brand/` (via `packages/brand`). No default shadcn palette, no ad-hoc hex values in components, dark mode is the default.
11. **Full product, built in dependency order.** The owner wants the complete, ambitious product, not a throwaway MVP. Build each milestone production-grade (tests, types, migrations, error handling), in the order in `docs/BUILD_PLAN.md`. Don't stub with fake logic that pretends to work; if something must wait, leave a typed interface plus a clear `TODO(milestone-N)` and a failing-closed implementation.

## Working style for Claude Code in this repo

- Start each milestone by restating its acceptance criteria and listing the files you will create.
- Use the task list; tick items as you go.
- After each milestone: run `pnpm typecheck && pnpm lint && pnpm test`, then update `docs/BUILD_PLAN.md` status and append to `docs/CHANGELOG.md`.
- When a doc and the code disagree, stop and ask, or fix the doc in the same commit with a note in `docs/DECISIONS.md`.
- When you need a vendor fact (CLI flag, API header, model id), check the vendor's current docs; `registry/connectors.json` records what was verified on 23 Oct 2026 and may drift.
- Prefer small, well-named modules; pure functions in `packages/core` with unit tests.

## Commands (create these in M0)

```
pnpm install
pnpm dev            # web + api + runner (docker) locally
pnpm db:generate    # drizzle-kit generate
pnpm db:migrate
pnpm db:seed        # demo workspace + project
pnpm db:reset       # recreate a *_e2e / *_test database (refuses others)
pnpm typecheck
pnpm lint
pnpm test
pnpm e2e
pnpm evals          # golden missions
```

## Definition of done (every milestone)

- Acceptance criteria in `docs/BUILD_PLAN.md` met and demonstrated by tests.
- Typecheck, lint, unit + integration tests green; e2e green where UI changed.
- Migrations generated and applied cleanly on an empty DB.
- Events emitted for every new action; visible on the live board.
- Docs updated; CHANGELOG entry written; committed in small steps (pushed only per rule 9).
