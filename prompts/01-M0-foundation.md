# M0 — Foundation: monorepo, CI, DB, auth, workspaces, vault, events

Paste into Claude Code when the previous milestone is done.

Implement **M0** from `docs/BUILD_PLAN.md`.

**Scope:** Set up the monorepo exactly as in CLAUDE.md, implement every Drizzle table in ARCHITECTURE §3 with migrations, Better Auth with organisations, the events writer with per-mission seq and SSE resume, the vault with envelope encryption and redactor, and the hash-chained ledger with an UPDATE/DELETE-blocking trigger.

**Notes for this milestone:** Write the redactor and ledger tamper tests before the implementations. Keep the stub planner obviously labelled `TODO(milestone-3)` and failing closed for anything but the single demo task.

**Process**
1. Re-read `CLAUDE.md` rules and the M0 section of `docs/BUILD_PLAN.md`; restate its deliverables and acceptance criteria as your task list.
2. List the files and migrations you will create or change, then build.
3. Keep vendor-specific code inside `packages/adapters`; keep decision logic pure and unit-tested in `packages/core`.
4. Emit events for every new action and make them visible on the live board.
5. Finish with `pnpm typecheck && pnpm lint && pnpm test` (plus `pnpm e2e` if UI changed), update the M0 status in `docs/BUILD_PLAN.md`, append to `docs/CHANGELOG.md`, and commit locally. Do not push.
6. Report: what was built, test evidence, any decisions you made (also added to `docs/DECISIONS.md`), and anything blocked.
