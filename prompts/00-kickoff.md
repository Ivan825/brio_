# Kickoff prompt — paste this into Claude Code first

You are building **Brio**, a multi-agent orchestrator, in this repository.

1. Read `CLAUDE.md` fully. Its non-negotiable rules apply to everything you do (especially: no consumer-UI automation or token reuse, every vendor call through `AgentAdapter`, every action an event, sandbox by default, commit locally but never push).
2. Read `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` and `docs/BUILD_PLAN.md`. Skim `brand/BRAND.md`, `docs/ADAPTER_SPEC.md`, `docs/ROUTING_AND_QUALITY.md`, `docs/SECURITY_GOVERNANCE.md`, `docs/HANDOFF_PACKET.md` and `registry/connectors.json`.
3. `docs/HANDOFF_PACKET.md` §2 is the handoff packet from the planning session to you. Treat its decisions as settled. For each open question, use the stated default and note it in `docs/DECISIONS.md`; don't stop to ask unless a default is impossible to apply.
4. Reply with:
   - a one-paragraph summary of what Brio is, in your own words;
   - anything in the docs that contradicts itself or looks infeasible, with your proposed fix;
   - the file list you will create for M0.
5. Then start **M0** using `prompts/01-M0-foundation.md`. Use your task list, tick items as you go, and finish with the Definition of Done in `CLAUDE.md`.

Work milestone by milestone. At the end of each milestone, update the status column in `docs/BUILD_PLAN.md`, append to `docs/CHANGELOG.md`, commit locally, and tell me which prompt file to give you next.
