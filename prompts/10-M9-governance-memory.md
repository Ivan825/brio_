# M9 — Governance, memory graph, notifications, orgs/RBAC

Paste into Claude Code when the previous milestone is done.

Implement **M9** from `docs/BUILD_PLAN.md`.

**Scope:** Complete budgets, policy engine, approvals across channels, ledger UI and verifier, optional Mandate connection (D-07), memory graph ingest and get_brief with a memory UI, notifications (Resend email, Slack, web push), and role enforcement everywhere.

**Notes for this milestone:** Ask the owner to decide D-07 and D-14 at the start of this milestone; proceed with the defaults if no answer. Property-test that confidential tasks can never reach a disallowed connector.

**Process**
1. Re-read `CLAUDE.md` rules and the M9 section of `docs/BUILD_PLAN.md`; restate its deliverables and acceptance criteria as your task list.
2. List the files and migrations you will create or change, then build.
3. Keep vendor-specific code inside `packages/adapters`; keep decision logic pure and unit-tested in `packages/core`.
4. Emit events for every new action and make them visible on the live board.
5. Finish with `pnpm typecheck && pnpm lint && pnpm test` (plus `pnpm e2e` if UI changed), update the M9 status in `docs/BUILD_PLAN.md`, append to `docs/CHANGELOG.md`, and commit locally. Do not push.
6. Report: what was built, test evidence, any decisions you made (also added to `docs/DECISIONS.md`), and anything blocked.
