# Changelog

## 2026-10-23 — M1 Connectors and model APIs
Pushed in small steps (CLAUDE.md rule 9, D-17).
- **Registry:** `@brio/registry` validates `registry/connectors.json` (98 connectors, 13 categories with task types), looks up capable connectors by task type, and fails CI when a planned P0/P1 connector has no adapter. Vendor presets are data (D-27): 18 presets (OpenAI, Anthropic, Gemini, xAI, Meta, Mistral, DeepSeek, Kimi, GLM, Qwen, Sarvam, OpenRouter, LiteLLM, Ollama, vLLM, Groq, Together, Fireworks), each checked against the vendor's docs on 23 Oct 2026.
- **Adapters:** `AgentAdapter` (ADAPTER_SPEC §1, D-31), the contract suite (health, model list, estimate, hello task, tool loop, cancel, time and cost limits, vendor errors and retries, credential redaction), and three families over native HTTP (D-28): `openai-compatible` (Responses and Chat Completions), `anthropic` (Messages with prompt caching, thinking blocks echoed), `gemini` (generateContent with thought signatures). One internal tool loop for all; sandbox file tools fail closed until M2, search and mailbox tools are typed interfaces offered only when backed. Every request passes a URL guard (D-32). Live tests per vendor behind `LIVE_<VENDOR>=1`.
- **Metering:** cost maths in `@brio/core` (cache reads and writes, reasoning, long-context tiers, DeepSeek off-peak, micro-dollar rounding); `model_prices` seeded from `registry/prices.json` and refreshed live from OpenRouter and vendor model lists; vendor-reported cost preferred (OpenRouter, xAI, LiteLLM); a run with no known price is refused (D-30). An `attempt.cost` event per model call, a `spend` ledger entry per attempt.
- **API:** catalogue (`/v1/registry`), connectors (keys into the vault, health check, live model list, rotate, remove), agents (connector + model + role prompt + limits + optional price), direct task runs with cancel and output (D-29), pricing list and refresh; attempts orphaned by a restart are marked failed.
- **Web:** connector catalogue grouped by category with route chips, status, tier, search and "available now"; add-key form per preset (regions, base URL, API style), health and live model lists with prices; agent builder; Run task on the mission board with live cost, attempt status and the stored answer.
- **Database:** `connector_models`, `model_prices`, `blobs` (D-35); agents gain `price_override` and `options`; ledger kinds `connector.added` / `connector.removed`.
- **Acceptance evidence:** contract suite green for every family and API style, request wiring and free key checks for all 18 presets, API integration test (keys for four vendors incl. a bad one, health, live lists, agents, metered run with cost within 2% of usage, cancel, unknown price refused, restart recovery, keys absent from logs/events/ledger), Playwright (catalogue, add key → models → agent → run → cost and answer on the board).
- **Not yet verified live:** runs against real vendors need the owner's keys (`pnpm --filter @brio/adapters test:live`).

## 2026-10-23 — M0 Foundation
Pushed in small steps (CLAUDE.md rule 9, D-17).
- **Repo and tooling:** pack moved to the repo root; pnpm workspaces + Turborepo, strict TypeScript 6 (D-18), Biome, Vitest, Playwright; GitHub Actions CI (typecheck, lint, unit + integration tests against Postgres, migrations on an empty database, schema drift check, e2e).
- **Brand:** `@brio/brand` mirrors `brand/` byte for byte, maps shadcn/ui variables onto Brio tokens, and a test fails on any colour literal or Tailwind default-palette class outside the package (rule 10). Tailwind 3.4 LTS (D-19).
- **Web:** Next.js 16 shell in the Brio brand (dark default, light toggle, Geist, `brio_` wordmark with a cursor that blinks while anything runs, icons/manifest/OG), magic-link and passkey sign-in, workspace switcher, settings with members and invitations, missions list, live mission board over SSE.
- **Schema:** Zod schemas for every M0 entity, task taxonomy v1 and event types, kept in sync with the docs by tests.
- **Database:** Drizzle schema for all 32 tables, pgvector, append-only triggers on `events` and `ledger`, idempotent seed, docker compose Postgres on port 5433.
- **Vault:** envelope encryption (AES-256-GCM data keys, local or AWS KMS KEKs, rotation), `SecretValue`, and the redactor (tests written first) wired into logs, events and the ledger.
- **Events and ledger:** gapless per-mission `seq`, LISTEN/NOTIFY fan-out, resumable streams (D-22); per-workspace hash-chained ledger whose tamper tests were written first (D-21).
- **API:** Fastify with Better Auth (magic link, passkeys, Google when configured, organisations as workspaces, D-23), workspace CRUD/switch/invite, `POST /v1/missions` with the fail-closed stub planner (`TODO(milestone-3)`), SSE with Last-Event-ID resume and connection rotation (D-25).
- **Acceptance evidence:** API integration tests (sign-in, create/invite/accept/switch, missions → events, SSE resume, planted secret absent from logs/events/ledger) and Playwright (brand, every screen, full invite flow, live board with resume across reconnects).

## 2026-10-23 — Build pack
- Planning session output: PRD, architecture, adapter spec, routing and quality design, security and governance, handoff packet spec, decisions, build plan, connector registry (98 entries), milestone prompts.
- Product named Brio (D-13). Brand added: `brio_` logo set, dark-first tokens, Tailwind preset, BRAND.md.
