# M10 — Self-host, hardening, docs, launch readiness

Paste into Claude Code when the previous milestone is done.

Implement **M10** from `docs/BUILD_PLAN.md`.

**Scope:** Produce the Helm chart and Compose bundle, threat model and security tests (sandbox escape, prompt injection), load tests to the SLOs in BUILD_PLAN M10, and the docs site including a community adapter SDK guide.

**Notes for this milestone:** The product is named Brio (D-13). Remind the owner to clear its trademark and domain before launch, and ask about D-15 (platform keys/billing) before billing work.

**Process**
1. Re-read `CLAUDE.md` rules and the M10 section of `docs/BUILD_PLAN.md`; restate its deliverables and acceptance criteria as your task list.
2. List the files and migrations you will create or change, then build.
3. Keep vendor-specific code inside `packages/adapters`; keep decision logic pure and unit-tested in `packages/core`.
4. Emit events for every new action and make them visible on the live board.
5. Finish with `pnpm typecheck && pnpm lint && pnpm test` (plus `pnpm e2e` if UI changed), update the M10 status in `docs/BUILD_PLAN.md`, append to `docs/CHANGELOG.md`, and commit locally. Do not push.
6. Report: what was built, test evidence, any decisions you made (also added to `docs/DECISIONS.md`), and anything blocked.
