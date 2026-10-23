# M1 — Connector framework, registry loader, model-API adapters, metering

Paste into Claude Code when the previous milestone is done.

Implement **M1** from `docs/BUILD_PLAN.md`.

**Scope:** Build packages/registry over registry/connectors.json, the AgentAdapter types and contract test suite from ADAPTER_SPEC §1 and §4, the openai-compatible, anthropic and gemini adapters with the internal tool loop, the presets listed in BUILD_PLAN M1, live model listing, pricing and cost events, and the connector catalogue + agent builder UI.

**Notes for this milestone:** Before writing each preset, check the vendor's current docs for base URL, auth header and model-list endpoint, and record the verified date in connectors.json. Meta Model API is US-only preview: implement it, but mark it region-limited in the UI.

**Process**
1. Re-read `CLAUDE.md` rules and the M1 section of `docs/BUILD_PLAN.md`; restate its deliverables and acceptance criteria as your task list.
2. List the files and migrations you will create or change, then build.
3. Keep vendor-specific code inside `packages/adapters`; keep decision logic pure and unit-tested in `packages/core`.
4. Emit events for every new action and make them visible on the live board.
5. Finish with `pnpm typecheck && pnpm lint && pnpm test` (plus `pnpm e2e` if UI changed), update the M1 status in `docs/BUILD_PLAN.md`, append to `docs/CHANGELOG.md`, and commit locally. Do not push.
6. Report: what was built, test evidence, any decisions you made (also added to `docs/DECISIONS.md`), and anything blocked.
