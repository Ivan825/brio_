# M3 — Missions, planner, DAG engine, contracts, leases, handoffs, mailbox

Paste into Claude Code when the previous milestone is done.

Implement **M3** from `docs/BUILD_PLAN.md`.

**Scope:** Implement the planner (ROUTING §2), plan editor API and versions, the idempotent scheduler state machine (ARCHITECTURE §4.2), task-level leases, the contract registry with change propagation, handoff packet generation and injection (HANDOFF_PACKET.md), and the brio-mailbox MCP server, with a temporary static router.

**Notes for this milestone:** Write the crash-resume test first: kill the API mid-mission and prove the mission completes after restart. Use the 'Add OAuth login + tests to sample Next.js app' golden mission as the end-to-end target.

**Process**
1. Re-read `CLAUDE.md` rules and the M3 section of `docs/BUILD_PLAN.md`; restate its deliverables and acceptance criteria as your task list.
2. List the files and migrations you will create or change, then build.
3. Keep vendor-specific code inside `packages/adapters`; keep decision logic pure and unit-tested in `packages/core`.
4. Emit events for every new action and make them visible on the live board.
5. Finish with `pnpm typecheck && pnpm lint && pnpm test` (plus `pnpm e2e` if UI changed), update the M3 status in `docs/BUILD_PLAN.md`, append to `docs/CHANGELOG.md`, and commit locally. Do not push.
6. Report: what was built, test evidence, any decisions you made (also added to `docs/DECISIONS.md`), and anything blocked.
