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

> **Pre-alpha, being built in the open.** M0 to M8 are done: connectors, sandboxed coding agents, missions that plan, run as a graph and coordinate, a router that learns who wins, a verifier, merge engine and eval harness that check the work, hosted, browser, media and research agents, Brio as an MCP server and an A2A agent, and the complete web app, the `brio` CLI and the local runner. Governance, memory, notifications and organisations come next. This README describes
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

**Your keys, official routes only.** Brio uses official APIs, CLIs and SDKs with your own keys. It never automates consumer chat apps and never reuses a CLI's stored login tokens. On your own machine, a local runner can run a coding CLI under your own sign-in where the vendor's terms allow it (Antigravity; Claude Code for your own work), without Brio ever reading that sign-in.

## What you get

**The live board.** One lane per agent, task cards with IDs, a brass progress line for running work and verdict chips (pass / revise / fail). Everything on it streams from an append-only event log, so a reconnect resumes exactly where it left off.

**Execution modes.** *Built*, M4. Single, best-of-n, ensemble, maker–checker, debate, cascade and pipeline, chosen per task by default rules or by you in the plan editor.

**Proof, not vibes.** Every result arrives with its evidence: test output, typecheck, the reviewer's verdict and reasons, and the diff.

**A scoreboard you own.** Which agent wins at which task type, at what cost and speed, measured on your own work. *Built*, M4.

**Governance built in.** Per-workspace, mission, task and agent budgets; approval policies; a BYOK vault with envelope encryption; a tamper-evident ledger. The schemas are compatible with [Mandate](https://github.com/Ivan825/Mandate), so spending authority can be delegated to it.

**People.** Workspaces with owners and members, invitations, and sign-in with Google, email links or passkeys. Dark by default, with a light theme.

**From goal to pull request.** Compose a mission from a goal, a GitHub issue, files and a project; edit the plan as a list or a graph; watch it run; approve the pull request in the inbox; read the report. *Built*, M8.

## The CLI and your own machine

```bash
pnpm --filter @brio/cli exec brio login --url http://localhost:3000   # approve the code in the browser
brio run "Add a health endpoint, with tests" --project site --watch
brio plan <mission> --gate api.health          # edits make a new plan version
brio approve                                   # what waits for you; brio approve <mission> to start it
brio board <mission>                           # the live board in the terminal
brio runner register --name laptop [--host]    # this machine as a runner (host mode asks for consent)
brio runner start
```

## Host it yourself

Brio is self-hosted: there is no Brio cloud. It runs on a machine you control, with your own vendor keys, and you need no domain or account with us. Pick a machine:

| Where | Cost | Address | Guide |
|---|---|---|---|
| **A cloud server** (always on) | free with Azure for Students, or about €5–25/month anywhere | a free `*.cloudapp.azure.com` or `*.duckdns.org` name, with automatic HTTPS | [`docs/DEPLOY_CLOUD.md`](docs/DEPLOY_CLOUD.md) |
| **Your own computer** | free | `localhost`, or a free Tailscale Funnel address | [`docs/DEPLOY_CLOUD.md`](docs/DEPLOY_CLOUD.md) | A cloud server, always on, with free HTTPS and no domain: Azure for Students or any Ubuntu server with DuckDNS |
| [`docs/OWNER_SETUP.md`](docs/OWNER_SETUP.md) |
| **Kubernetes** | your cluster | your ingress | [`docs/SELF_HOST.md`](docs/SELF_HOST.md#2-kubernetes-with-helm-about-25-minutes) |

The server needs at least 2 CPUs, 4 GB RAM with swap, and a 64 GB disk. 4 CPUs, 8 GB and 80–100 GB are comfortable for a small team.

On a fresh Ubuntu server, the whole install is:

```bash
curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER   # then log in again
git clone https://github.com/Ivan825/brio_.git brio && cd brio/deploy/compose
./setup.sh https://brio-you.duckdns.org
nano .env                # BRIO_SITE_ADDRESS=brio-you.duckdns.org, ports 80/443, BRIO_SIGNUP_ALLOW=you@example.com
docker compose up -d     # builds, migrates, starts; Caddy gets the HTTPS certificate
```

[`docs/SELF_HOST.md`](docs/SELF_HOST.md) lists every setting and covers backups, upgrades and a smoke test that proves an install works. [`docs/OWNER_SETUP.md`](docs/OWNER_SETUP.md) covers the rest with free accounts only:
- email from your Gmail;
- Slack and browser push;
- Claude Code over MCP;
- the local runner;
- the website.

## Run it locally

Node 22, pnpm 10 and Docker (Postgres with pgvector, and the sandboxes agents run in).

```bash
git clone https://github.com/Ivan825/brio_.git && cd brio_
pnpm install
cp .env.example .env          # then fill BETTER_AUTH_SECRET and BRIO_VAULT_LOCAL_KEK (openssl rand -base64 32)
docker compose up -d --wait   # Postgres + pgvector on :5433
pnpm db:migrate && pnpm db:seed
pnpm dev                      # Postgres, API on :4000, runner, web on http://localhost:3000
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
apps/      web · api · runner · cli · evals · site (the product website)
packages/  schema · db · core · adapters · registry · vault · governance · memory · sdk · brand
```

Every vendor call goes through one `AgentAdapter` interface ([`docs/ADAPTER_SPEC.md`](docs/ADAPTER_SPEC.md)), every agent action is an event, and every task has a contract before it is dispatched.

## Documentation

| | |
|---|---|
| [`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md) | From nothing to a finished mission (also served at `/docs`) |
| [`docs/SELF_HOST.md`](docs/SELF_HOST.md) | Docker Compose or Helm, every setting, backups, upgrades |
| [`docs/OWNER_SETUP.md`](docs/OWNER_SETUP.md) | Step by step with no domain and free accounts: Gmail email, a Tailscale address, Slack, push, local runner, live tests, the website |
| [`docs/API.md`](docs/API.md) | Every REST route, generated from the code |
| [`docs/ADAPTERS.md`](docs/ADAPTERS.md) | Writing an adapter for a new agent or model |
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

All eleven milestones (M0–M10) are built, in dependency order, each with tests, types, migrations and docs: the foundation, connectors and model APIs, sandboxed runners and coding CLIs, missions and coordination, the learned router and execution modes, verification and evals, hosted, browser, media and research agents, MCP, A2A and ACP, the complete web app with the CLI and local runners, governance, memory, notifications and roles, and self-hosting, hardening and the docs site. Each milestone's acceptance evidence is in [`docs/CHANGELOG.md`](docs/CHANGELOG.md); the security review is in [`docs/SECURITY_REVIEW.md`](docs/SECURITY_REVIEW.md) and the load test in [`docs/LOAD_TEST.md`](docs/LOAD_TEST.md).

What still needs the owner: live runs against real vendors (their keys), a public deployment (for remote MCP and A2A clients and webhooks), and the accounts Brio sends through (Google sign-in, Resend, Slack, web push keys).

## Licence

[AGPL-3.0](LICENSE). Self-host it, fork it, build on it. If you run a modified version as a service, publish your changes.
