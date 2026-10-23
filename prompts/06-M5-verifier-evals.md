# M5 — Verifier, judge, merge, eval harness

Paste into Claude Code when the previous milestone is done.

Implement **M5** from `docs/BUILD_PLAN.md`.

**Scope:** Implement every check kind in ROUTING §4.1, the cross-vendor rubric reviewer, verdict/revise/reroute logic, the order-swapped pairwise judge, the merge engine with merge.integrate tasks, the mission report, and apps/evals with 30 golden missions and baselines.

**Notes for this milestone:** Add a property test that the reviewer's vendor never equals the maker's vendor. Parallel-safe with M4, M6, M7.

**Process**
1. Re-read `CLAUDE.md` rules and the M5 section of `docs/BUILD_PLAN.md`; restate its deliverables and acceptance criteria as your task list.
2. List the files and migrations you will create or change, then build.
3. Keep vendor-specific code inside `packages/adapters`; keep decision logic pure and unit-tested in `packages/core`.
4. Emit events for every new action and make them visible on the live board.
5. Finish with `pnpm typecheck && pnpm lint && pnpm test` (plus `pnpm e2e` if UI changed), update the M5 status in `docs/BUILD_PLAN.md`, append to `docs/CHANGELOG.md`, and commit locally. Do not push.
6. Report: what was built, test evidence, any decisions you made (also added to `docs/DECISIONS.md`), and anything blocked.
