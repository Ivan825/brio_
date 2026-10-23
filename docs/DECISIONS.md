# Decisions (ADR-lite)

Status key: **Decided** (build on it), **Default** (chosen so work can proceed; owner may change), **Open** (needs owner input before the milestone named).

| ID | Decision | Status | Why | Alternatives considered |
|---|---|---|---|---|
| D-01 | TypeScript monorepo, pnpm + Turborepo, Node 22 | Decided | One language for web, API, adapters, SDK; owner's Mandate is TS | Python backend (better ML libs, but splits the codebase) |
| D-02 | Postgres (Neon) + Drizzle + pgvector; `pg-boss` queue; run state machine persisted in Postgres | Decided | Minimal infra, self-host friendly, matches Mandate | Temporal (durable but heavy to self-host), Inngest (hosted dependency), Redis/BullMQ (extra infra) — revisit Temporal if run complexity explodes |
| D-03 | BYOK-only vendor access; no consumer-UI automation; no token reuse | Decided | ToS, reliability, trust | Browser-scraping consumer apps (rejected) |
| D-04 | Full product, built in dependency order; no throwaway MVP | Decided | Owner preference; each milestone production-grade | MVP-then-iterate (rejected by owner) |
| D-05 | Claude Code commits locally; owner pushes | Superseded by D-17 | Owner rule | — |
| D-06 | API + orchestrator on Fastify in containers; web on Vercel; runners on Docker hosts | Decided | Long-running streams and sandboxes can't live on serverless | All-in Next.js on Vercel (rejected: timeouts) |
| D-07 | Governance: native `packages/governance` with Mandate-compatible schemas | Default | Fewer moving parts; Mandate connectable later | Delegate to a Mandate instance from day one |
| D-08 | Memory graph in Postgres tables + pgvector (graph abstraction in `packages/memory`) | Default | One database | FalkorDB/Neo4j (Relay uses FalkorDB) — swap behind interface if graph queries get heavy |
| D-09 | Licence: open-core, AGPL-3.0 for core; hosted cloud commercial | Default | Mirrors Mandate's choice | MIT (easier adoption, weaker moat), BSL |
| D-10 | Router = Thompson sampling with cost/latency utility; Elo from pairwise judgments | Decided | Simple, explainable, learns online | Learned ranking model (later, when data exists) |
| D-11 | Cross-vendor review mandatory for non-trivial outputs | Decided | Core differentiator; errors correlate within a vendor | Same-vendor self-review (cheaper, weaker) |
| D-12 | Beachhead user: prosumer builder running 3+ agents; GitHub repos first | Default | Fastest feedback; owner fits persona | Teams first, enterprise first |
| D-13 | Product name is **Brio** (from "con brio", play with spirit); brand strings centralised in `packages/brand` | Decided (23 Oct 2026) | Short, easy to say, orchestra-related, no AI product conflict found | Roster (placeholder), Orchestrion, Tutti (crowded), Consort, Fulcrum; owner to clear trademark and domain before public launch |
| D-14 | Global opt-in scoreboard (anonymised cross-workspace priors) | Open (before M9) | Strong cold-start advantage; privacy implications | Workspace-only scores |
| D-15 | Platform keys (Brio pays vendors, resells with margin) in addition to BYOK | Open (before billing) | Lower friction for non-technical users | BYOK only + platform fee |
| D-16 | Relay as optional coordination backend for teams already on it | Default: later (M9+) | Interop goodwill | Ignore |
| D-17 | Claude Code may push to `origin` as the owner's logged-in account (Ivan825) when the owner authorises it, in small per-step pushes; no bot/AI identity, co-author trailer or AI GitHub Action ever touches the repo | Decided (23 Oct 2026) | Owner instruction at M0 start | Owner pushes everything (D-05) |
| D-18 | TypeScript 6.0.x, not 7.x | Default (M0) | TS 7 is the native (Go) compiler without the JS compiler API that Next.js, drizzle-kit and other tools still load | TS 7 (revisit once the toolchain supports it) |
| D-19 | Tailwind CSS 3.4 LTS | Default (M0) | `brand/tailwind.preset.ts` is a v3 JS preset (`presets`, `darkMode`); v3 uses it unchanged | Tailwind 4 with `@config` compat layer |
| D-20 | Internal workspace packages export TypeScript source (`exports: ./src/index.ts`), no per-package build | Default (M0) | No build ordering or stale `dist/` during development; Next.js uses `transpilePackages`, the API runs through tsx | Per-package tsc/tsup builds (add if a package is published to npm, e.g. `sdk`) |
| D-21 | Ledger hash = sha256(prev_hash ‖ canonical_json({workspaceId, seq, kind, payload})), one chain per workspace, appends serialised by an advisory lock | Decided (M0) | Refines SECURITY_GOVERNANCE §8 (which hashes the payload only): binding seq, kind and workspace stops entries being renumbered, relabelled or moved between chains | Hash the payload only |
| D-22 | Events writer lives in `packages/db` and must be constructed with a redactor; seq comes from `missions.last_event_seq` under a row lock; live fan-out via Postgres LISTEN/NOTIFY, reads always from the table | Decided (M0) | Gapless per-mission seq without extra infra; SSE resume is a plain `seq > Last-Event-ID` query; no payload can be written unredacted | Sequence per mission; Redis pub/sub |
| D-23 | Workspaces are Better Auth organisations (organization/member/invitation mapped onto `workspaces`/`members`/`invitations`, session.activeOrganizationId → `active_workspace_id`); invite roles limited to admin/member until RBAC in M9 | Decided (M0) | One source of truth for membership and invitations; Better Auth handles accept/expiry | Separate workspace tables synced from auth |
| D-24 | The browser only talks to the web origin: Next.js rewrites `/api/auth/*` and `/v1/*` to the API | Decided (M0) | First-party auth cookies, no CORS, SSE works unchanged; the API stays a separate long-running service (D-06) | Cross-origin API with CORS + SameSite=None cookies |
| D-25 | SSE connections are closed after `BRIO_SSE_MAX_CONNECTION_MS` (default 5 min); clients reconnect with Last-Event-ID | Decided (M0) | Keeps connections fresh behind proxies/load balancers and continuously exercises the resume path | Unbounded connections |
| D-26 | M0 email is a local LogMailer (logged + dev outbox at `GET /v1/dev/outbox` when `BRIO_DEV_OUTBOX=true`, refused in production) | Default (M0) | Acceptance asks for invites logged locally; a real provider arrives with notifications in M9 | Wire an email provider now |

When you change or add a decision, add a row, keep the old one with status **Superseded by D-xx**, and note the commit.
