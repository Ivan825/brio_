# Changelog

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
