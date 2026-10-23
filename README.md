<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/logo/brio-wordmark-dark.svg">
    <img src="brand/logo/brio-wordmark-light.svg" alt="brio_" width="280">
  </picture>
</p>

<p align="center"><strong>Every AI, one ensemble.</strong><br>
Give Brio one goal. It plans the work, hands each piece to the agent best at it, across every vendor, has another vendor's model check the result, and learns who wins.</p>

<p align="center">
  <a href="https://github.com/Ivan825/brio_/actions/workflows/ci.yml"><img src="https://github.com/Ivan825/brio_/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-AGPL--3.0-blue.svg" alt="AGPL-3.0 licence"></a>
  <img src="https://img.shields.io/badge/status-pre--alpha-F2B33D" alt="Pre-alpha">
  <img src="https://img.shields.io/badge/node-22-339933" alt="Node 22">
  <img src="https://img.shields.io/badge/BYOK-only-6C8CFF" alt="Bring your own keys">
</p>

<p align="center">
  <a href="#how-it-works">How it works</a> ·
  <a href="#run-it-locally">Run locally</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="docs/BUILD_PLAN.md">Roadmap</a> ·
  <a href="docs/DECISIONS.md">Decisions</a>
</p>

---

> **Pre-alpha, being built in the open.** M0 (foundation) and M1 (connectors and model APIs) are done; coding agents in sandboxes come next. This README describes
> the product Brio is being built to be; the [roadmap](docs/BUILD_PLAN.md) shows what is done, and anything
> not built yet is marked **planned** below.

## The problem

You already run several AI agents. Claude Code is in one terminal, Codex is in the cloud, Gemini is reading a long document, a research agent is gathering sources, and an image model is making the hero shot. Each one is best at something different, and none of them knows the others exist.

So you are the integration layer. You decide by gut feel who gets which part, copy context between tools and lose half of it, find out about collisions at merge time, and review everything yourself, because no agent checks another. You can't tell which agent is actually better at what, or what it all costs.

Brio is the conductor, not another agent. You state the goal; Brio gets the best result the ecosystem can produce, with proof, and gets better at it every run.

## How it works

```
$ brio run "add passkey sign-in to the web app, with tests and docs"

plan      4 tasks · 2 contracts · budget $3.00          → approve
codex     → task 1  auth routes        · tests passed   · $0.31 · 2m14s
claude    → task 2  sign-in UI         · review: pass   · $0.42 · 3m02s
gemini    → task 3  docs               · review: revise → pass
verify    typecheck ✓  tests ✓  cross-vendor review ✓
done      PR ready · $1.12 · 6m40s_
```

| Step | What Brio does |
|---|---|
| **Plan** | Turns the goal into a graph of tasks, each with an explicit contract: inputs, outputs and acceptance checks. You approve the plan before anything runs. |
| **Route** | Sends each task to the best agent or model for that task type, using a live scoreboard of pass rate, cost and speed. Pin an agent whenever you like. |
| **Coordinate** | Agents work in parallel without trampling each other: task leases on files and contracts, structured handoff packets, a shared mailbox and project memory. |
| **Verify** | Tests, typecheck, and a model from a *different vendor* review every non-trivial result before you see it. Errors correlate within a vendor, so the checker never shares the maker's vendor. |
| **Learn** | Every verdict updates the scoreboard (Thompson sampling, plus Elo from pairwise judgements), so routing improves with every mission. |
| **Govern** | Budgets are checked before dispatch, irreversible actions (push, deploy, send, purchase) wait for approval, secrets stay in an encrypted vault, and every action is recorded on a hash-chained ledger. |

## What it connects to

98 connectors across 13 categories, recorded as data in [`registry/connectors.json`](registry/connectors.json) and listed in [`docs/CONNECTORS.md`](docs/CONNECTORS.md):

| Route | Examples |
|---|---|
| **Model APIs** | OpenAI, Anthropic, Google, xAI, Meta, Mistral, DeepSeek, Kimi, GLM, Qwen, Sarvam, OpenRouter, Groq, Together, Fireworks, Ollama / vLLM |
| **Coding CLIs** | Claude Code, Codex CLI, Gemini CLI, Cursor, and others driven as documented, in a sandbox |
| **Hosted agents** | Claude Managed Agents, OpenAI Agents API, Jules, Devin, Manus |
| **Protocols** | MCP (Brio is an MCP server *and* client), A2A, ACP |
| **Browser, media, research** | Browser agents, image, video and audio models, research agents |

**Your keys, official routes only.** Brio uses official APIs, CLIs and SDKs with your own keys. It never automates consumer chat apps and never reuses a CLI's stored login tokens.

## What you get

**The live board.** One lane per agent, task cards with IDs, a brass progress line for running work and verdict chips (pass / revise / fail). Everything on it streams from an append-only event log, so a reconnect resumes exactly where it left off.

**Execution modes.** *Planned.* Single, best-of-n, ensemble, maker–checker, debate, cascade and pipeline, chosen per task.

**Proof, not vibes.** Every result arrives with its evidence: test output, typecheck, the reviewer's verdict and reasons, and the diff.

**A scoreboard you own.** Which agent wins at which task type, at what cost and speed, measured on your own work. *Planned*, M4.

**Governance built in.** Per-workspace, mission, task and agent budgets; approval policies; a BYOK vault with envelope encryption; a tamper-evident ledger. The schemas are compatible with [Mandate](https://github.com/Ivan825/Mandate), so spending authority can be delegated to it.

**People.** Workspaces with owners and members, invitations, and sign-in with Google, email links or passkeys. Dark by default, with a light theme.

## Run it locally

Node 22, pnpm 10 and Docker (for Postgres with pgvector).

```bash
git clone https://github.com/Ivan825/brio_.git && cd brio_
pnpm install
cp .env.example .env          # then fill BETTER_AUTH_SECRET and BRIO_VAULT_LOCAL_KEK (openssl rand -base64 32)
docker compose up -d --wait   # Postgres + pgvector on :5433
pnpm db:migrate && pnpm db:seed
pnpm dev                      # Postgres, API on :4000, web on http://localhost:3000
```

Sign in with any email. Without an email provider, the sign-in link is printed in the API log (and available at `/v1/dev/outbox` while `BRIO_DEV_OUTBOX=true`).

```bash
pnpm typecheck && pnpm lint && pnpm test    # unit and integration
pnpm e2e                                    # real browser, brand and flows
```

`pnpm e2e` builds the web app and starts the API against a throwaway `brio_e2e` database.

## Architecture

TypeScript everywhere. It's a pnpm + Turborepo monorepo: Next.js for the web app, Fastify for the API and orchestrator, Docker sandboxes for runners, and Postgres (Drizzle, pgvector, pg-boss) as the only infrastructure.

```
apps/      web · api · runner · cli · evals
packages/  schema · db · core · adapters · registry · vault · governance · memory · sdk · brand
```

Every vendor call goes through one `AgentAdapter` interface ([`docs/ADAPTER_SPEC.md`](docs/ADAPTER_SPEC.md)), every agent action is an event, and every task has a contract before it is dispatched.

## Documentation

| | |
|---|---|
| [`docs/PRD.md`](docs/PRD.md) | The problem, users, requirements and metrics |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Services, data model, mission/task/attempt flows, sandboxes |
| [`docs/ROUTING_AND_QUALITY.md`](docs/ROUTING_AND_QUALITY.md) | Planner, router, execution modes, verifier, scoreboard, evals |
| [`docs/SECURITY_GOVERNANCE.md`](docs/SECURITY_GOVERNANCE.md) | Vendor terms, vault, sandboxing, budgets, approvals, ledger |
| [`docs/ADAPTER_SPEC.md`](docs/ADAPTER_SPEC.md) | The `AgentAdapter` interface and every connector family |
| [`docs/HANDOFF_PACKET.md`](docs/HANDOFF_PACKET.md) | The packet format agents pass to each other |
| [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md) | Milestones M0–M10 with acceptance criteria and status |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Every architectural decision, with alternatives |
| [`brand/BRAND.md`](brand/BRAND.md) | Logo, colour, type, UI style and voice |

## Status

Pre-alpha. Built milestone by milestone in dependency order, each production-grade with tests, types and migrations. **Done:** M0, the foundation (monorepo and CI, database, sign-in and workspaces, the vault and redactor, the event spine with live SSE, the hash-chained ledger, the branded web app), and M1, connectors and model APIs (18 vendor presets behind one adapter interface, live model lists, metered cost per call, the connector catalogue and agent builder, and running a task with a chosen agent). Next is **M2**: sandboxed coding agents. Planning is a labelled stub until M3. See the [roadmap](docs/BUILD_PLAN.md) and [`docs/CHANGELOG.md`](docs/CHANGELOG.md).

## Licence

[AGPL-3.0](LICENSE). Self-host it, fork it, build on it. If you run a modified version as a service, publish your changes.
