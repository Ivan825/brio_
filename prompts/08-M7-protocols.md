# M7 — Brio MCP server, A2A server and client, ACP

Paste into Claude Code when the previous milestone is done.

Implement **M7** from `docs/BUILD_PLAN.md`.

**Scope:** Implement the Brio MCP server (remote with OAuth 2.1 consent, local stdio) with the tools in BUILD_PLAN M7, the A2A server with Agent Card and streaming, the A2A client adapter with skill → task-type mapping UI, and ACP support in CliAdapterBase.

**Notes for this milestone:** Verify the official A2A JS SDK package name and protocol version on npm before installing. The acceptance demo is Claude Code calling brio.delegate to fan work out to Gemini and Codex.

**Process**
1. Re-read `CLAUDE.md` rules and the M7 section of `docs/BUILD_PLAN.md`; restate its deliverables and acceptance criteria as your task list.
2. List the files and migrations you will create or change, then build.
3. Keep vendor-specific code inside `packages/adapters`; keep decision logic pure and unit-tested in `packages/core`.
4. Emit events for every new action and make them visible on the live board.
5. Finish with `pnpm typecheck && pnpm lint && pnpm test` (plus `pnpm e2e` if UI changed), update the M7 status in `docs/BUILD_PLAN.md`, append to `docs/CHANGELOG.md`, and commit locally. Do not push.
6. Report: what was built, test evidence, any decisions you made (also added to `docs/DECISIONS.md`), and anything blocked.
