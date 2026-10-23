# M8 — Web app complete, CLI and local runner

Paste into Claude Code when the previous milestone is done.

Implement **M8** from `docs/BUILD_PLAN.md`.

**Scope:** Finish the web app surfaces listed in BUILD_PLAN M8, the brio CLI (login, run, plan, board TUI, approve) and the local runner daemon (outbound WebSocket, local jobs, local sandbox or explicit-consent restricted mode).

**Notes for this milestone:** Load the frontend-design guidance if available. The live board is the product's centrepiece: tasks, agents, leases, mailbox messages, costs and verdicts must be readable at a glance. Playwright e2e for the full mission journey is the gate.

**Process**
1. Re-read `CLAUDE.md` rules and the M8 section of `docs/BUILD_PLAN.md`; restate its deliverables and acceptance criteria as your task list.
2. List the files and migrations you will create or change, then build.
3. Keep vendor-specific code inside `packages/adapters`; keep decision logic pure and unit-tested in `packages/core`.
4. Emit events for every new action and make them visible on the live board.
5. Finish with `pnpm typecheck && pnpm lint && pnpm test` (plus `pnpm e2e` if UI changed), update the M8 status in `docs/BUILD_PLAN.md`, append to `docs/CHANGELOG.md`, and commit locally. Do not push.
6. Report: what was built, test evidence, any decisions you made (also added to `docs/DECISIONS.md`), and anything blocked.
