# M4 — Router, execution modes, scoreboard

Paste into Claude Code when the previous milestone is done.

Implement **M4** from `docs/BUILD_PLAN.md`.

**Scope:** Implement the router from ROUTING §3 (filtering, Thompson sampling with cost/latency utility, rationale), all seven execution modes, scoreboard updates with decay and new-model priors, and the scoreboard UI.

**Notes for this milestone:** Build a simulation harness with synthetic agents of known quality and cost; the convergence test in BUILD_PLAN M4 is the acceptance gate. This can run in a separate worktree in parallel with M5–M7.

**Process**
1. Re-read `CLAUDE.md` rules and the M4 section of `docs/BUILD_PLAN.md`; restate its deliverables and acceptance criteria as your task list.
2. List the files and migrations you will create or change, then build.
3. Keep vendor-specific code inside `packages/adapters`; keep decision logic pure and unit-tested in `packages/core`.
4. Emit events for every new action and make them visible on the live board.
5. Finish with `pnpm typecheck && pnpm lint && pnpm test` (plus `pnpm e2e` if UI changed), update the M4 status in `docs/BUILD_PLAN.md`, append to `docs/CHANGELOG.md`, and commit locally. Do not push.
6. Report: what was built, test evidence, any decisions you made (also added to `docs/DECISIONS.md`), and anything blocked.
