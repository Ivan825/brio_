# M6 — Hosted-agent, browser, media and research adapters

Paste into Claude Code when the previous milestone is done.

Implement **M6** from `docs/BUILD_PLAN.md`.

**Scope:** Implement the hosted adapters (Claude Managed Agents, OpenAI Agents API incl. requires_action → approvals, Gemini Managed Agents, Jules, Devin, Manus with webhooks, Bedrock AgentCore, Foundry agents), browser adapters (Anthropic computer use, Nova Act, Browser Use, cloud browser abstraction), media adapters (async job pattern), research tools as shared MCP, and the unsupported-connector UX.

**Notes for this milestone:** Beta headers to confirm: Claude Managed Agents `managed-agents-2026-04-01`; OpenAI Agents API `OpenAI-Beta: agents=v1`. Claude Managed Agents is not ZDR/HIPAA eligible: register it as excluded from `confidential` tasks by default. No adapters for Midjourney, Suno/Udio, Comet or consumer apps.

**Process**
1. Re-read `CLAUDE.md` rules and the M6 section of `docs/BUILD_PLAN.md`; restate its deliverables and acceptance criteria as your task list.
2. List the files and migrations you will create or change, then build.
3. Keep vendor-specific code inside `packages/adapters`; keep decision logic pure and unit-tested in `packages/core`.
4. Emit events for every new action and make them visible on the live board.
5. Finish with `pnpm typecheck && pnpm lint && pnpm test` (plus `pnpm e2e` if UI changed), update the M6 status in `docs/BUILD_PLAN.md`, append to `docs/CHANGELOG.md`, and commit locally. Do not push.
6. Report: what was built, test evidence, any decisions you made (also added to `docs/DECISIONS.md`), and anything blocked.
