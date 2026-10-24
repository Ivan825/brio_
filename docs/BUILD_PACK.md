# Brio build pack (how this repo was started)

Everything Claude Code needs to build Brio, the multi-agent orchestrator: product spec, architecture, adapter contracts, a milestone plan, the connector registry as data, and a ready-to-paste prompt for each milestone.

## How to use it

1. Create an empty folder for the project (for example `~/projects/Brio`) and copy the **contents** of this pack into it, so `CLAUDE.md` sits at the root.
2. In that folder run `git init`. Claude Code pushes only as the owner's account and only when authorised (CLAUDE.md rule 9, D-17).
3. Start Claude Code in the folder:
   ```bash
   cd ~/projects/Brio
   claude
   ```
4. Paste the whole of `prompts/00-kickoff.md` (the build prompts are kept locally, outside the repository). Claude Code reads the docs, flags any contradictions, and starts M0.
5. When it finishes a milestone, it tells you which prompt to paste next (`prompts/01-…` through `prompts/11-…`). M4–M7 can run in parallel in separate Claude Code sessions on separate git worktrees.

## What's inside

| File | What it is |
|---|---|
| `CLAUDE.md` | Project memory Claude Code reads every session: stack, layout, rules, definition of done |
| `PRD.md` | Product requirements: problem, users, 45 functional requirements, Relay gap mapping, metrics |
| `ARCHITECTURE.md` | Layers, services, full data model, mission/task/attempt flows, sandbox profiles |
| `ADAPTER_SPEC.md` | The `AgentAdapter` interface and how each connector family (APIs, CLIs, hosted agents, A2A, MCP, browser, media) plugs in |
| `ROUTING_AND_QUALITY.md` | Task taxonomy, planner, router algorithm, execution modes, verifier, scoreboard, eval harness |
| `SECURITY_GOVERNANCE.md` | Vendor-terms rules, BYOK vault, sandboxing, data policies, budgets, approvals, ledger, Mandate tie-in |
| `HANDOFF_PACKET.md` | The packet format agents pass to each other, with this pack written up as packet #0 |
| `DECISIONS.md` | Decided, default and open choices, with alternatives |
| `BUILD_PLAN.md` | M0–M10 with deliverables and acceptance tests |
| `CONNECTORS.md` | Human-readable connector registry (98 entries, 13 categories) |
| `registry/connectors.json` | The same registry as data; adapters and the UI load it |
| `brand/` | Logo files (`brio_`), colour tokens, Tailwind preset, brand guide |
| `prompts/` | Kickoff plus one prompt per milestone (local only: not in the repository, listed in `.gitignore`) |

## Open decisions you may want to settle early

- **D-07** Governance natively or through Mandate (default: native, Mandate-compatible).
- **D-14** Global opt-in scoreboard across workspaces (default: workspace-only until M9).
- **D-15** Platform keys and resale vs BYOK only (default: BYOK).

Vendor facts were checked on 23 Oct 2026. APIs, beta headers and CLI flags move monthly, so every milestone prompt tells Claude Code to re-verify before implementing.
