# M2 — Sandboxed runner and coding-CLI adapters

Paste into Claude Code when the previous milestone is done.

Implement **M2** from `docs/BUILD_PLAN.md`.

**Scope:** Build apps/runner with Docker sandbox profiles (ARCHITECTURE §5), egress allowlists, git worktree per attempt, artifact collection, heartbeats and a reaper; CliAdapterBase; and the claude-code, codex, cursor-agent, antigravity, opencode, aider and goose adapters; plus sandbox file tools for API-model agents.

**Notes for this milestone:** Run `<binary> --help` inside the image to confirm every headless flag before coding the adapter. Cursor needs `-p --trust` or it hangs. Antigravity's headless mode ignores permission allowlists (issue #548): never trust its exit status alone; verify by diff and checks. Never copy any CLI's stored login token.

**Process**
1. Re-read `CLAUDE.md` rules and the M2 section of `docs/BUILD_PLAN.md`; restate its deliverables and acceptance criteria as your task list.
2. List the files and migrations you will create or change, then build.
3. Keep vendor-specific code inside `packages/adapters`; keep decision logic pure and unit-tested in `packages/core`.
4. Emit events for every new action and make them visible on the live board.
5. Finish with `pnpm typecheck && pnpm lint && pnpm test` (plus `pnpm e2e` if UI changed), update the M2 status in `docs/BUILD_PLAN.md`, append to `docs/CHANGELOG.md`, and commit locally. Do not push.
6. Report: what was built, test evidence, any decisions you made (also added to `docs/DECISIONS.md`), and anything blocked.
