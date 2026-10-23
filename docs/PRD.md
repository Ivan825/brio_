# Brio — Product Requirements

Status: v1.0 (23 Oct 2026). Owner: Vaibhav. Product name: Brio (decided 23 Oct 2026; from the musical direction "con brio", play with spirit).

## 1. Problem

People and teams now run several AI agents and models at once: Claude Code in one terminal, Cursor in the editor, Codex in the cloud, Gemini for long documents, Grok for live X data, Midjourney-class tools for images, a research agent for sources. Each is best at something different. None of them knows the others exist.

Today the human is the integration layer. They:
- decide which agent gets which part of the work, by gut feel;
- copy context from one tool to the next and lose half of it;
- discover collisions at merge time (studies of 140k+ agent PRs found 27.7% hit merge conflicts, and 41.7% when two different agents overlap in time);
- review everything themselves, because no agent checks another;
- have no idea which agent is actually better at what, or what it all costs.

Existing tools solve slices:
- **Relay (relayBrain)** — file locks, dependency-aware locking, patch sync and a memory graph for 5 coding agents in one repo. It does not plan, route, message between agents, verify, learn, budget, or cover anything beyond code.
- **Multi-CLI wrappers** (clawtool, agent-cli-mcp, Operon, orkestra) — send a prompt to Claude/Codex/Gemini from one place. Coding only, no quality layer, no learning.
- **Vendor subagents** (Claude Code subagents, Codex multi-agent) — orchestrate their own models only.
- **Frameworks** (LangGraph, CrewAI, Agents SDK) — libraries for developers, not a product.

## 2. Product thesis

One interface where the user states the goal and Brio gets the best result the whole AI ecosystem can produce, safely, with proof, and gets better at it every run.

Defensible only as the combination of four things no competitor combines:
1. **Cross-domain** — code, research, writing, data, design, media, browser work; not just repos.
2. **Verified outcomes** — cross-vendor review and tests gate every result.
3. **Learned routing** — a live scoreboard of agent × task type × cost × latency drives assignment.
4. **Built-in governance** — budgets, approvals, audit, BYOK secrets (Mandate as the governance layer).

## 3. Users

| Segment | Job to be done | Beachhead? |
|---|---|---|
| **Prosumer builder** (indie dev, technical founder, power user running 3+ agents) | "Ship this feature / app / report using the best AI for each part, without babysitting." | **Yes — first** |
| Small product team (2–20) | Parallel agents on one codebase without collisions; shared memory; spend control. | Second |
| Agency / consultancy | Repeatable multi-agent pipelines per client (research → deck → site). | Third |
| Enterprise platform team | Delegate across internal A2A agents and external vendors with policy and audit. | Later |

Primary persona: **"Arjun", a technical founder** with Claude Max, ChatGPT Pro, a Cursor seat and API keys for 3–4 labs, who spends 2 hours a day moving context between agents and reviewing their output.

## 4. Core concepts (user-facing language)

- **Mission** — the goal the user gives ("Build a stock-screener web app with auth and a daily email").
- **Plan** — the task graph Brio proposes; the user can edit before running.
- **Task** — one unit of work with a **contract**: inputs, expected outputs, acceptance checks.
- **Agent** — a configured worker: a connector (e.g. Codex CLI, Grok API) + model + role + tools + limits.
- **Crew** — a saved set of agents and routing preferences ("My coding crew").
- **Attempt** — one agent's run at one task. A task may have several attempts (best-of-N, retries).
- **Handoff** — the structured packet passed when work moves between agents.
- **Board** — live view of every task, agent, lease, message, cost, and verdict.
- **Scoreboard** — who wins at what, measured.
- **Budget** — money and time limits per mission, task, agent, workspace.

## 5. Functional requirements (full scope)

### 5.1 Missions and planning
- F1. Create a mission from text, voice transcript, files, a repo URL, or an issue link.
- F2. Planner produces a task DAG with: task type (from a fixed taxonomy, see ROUTING doc), contract, dependencies, suggested agent(s) and mode, estimated cost and time.
- F3. Plan editor: reorder, split, merge, reassign, change mode, pin an agent, set per-task budget, add approval gates. Graph and list views.
- F4. Clarifying questions: planner asks at most 3 blocking questions before planning when the mission is ambiguous; otherwise states assumptions on the plan.
- F5. Templates: save a plan as a reusable pipeline (e.g. "Research → memo → deck").
- F6. Re-planning: when a task fails verification twice or a contract changes, planner proposes a revised sub-plan; user approves or auto-approves by policy.

### 5.2 Agents and connectors
- F7. Connector catalogue from `registry/connectors.json` (98 entries at launch, 13 categories). Each shows routes, status, and setup steps.
- F8. Add a connector: paste API key (BYOK), sign in via OAuth where the vendor supports it, or register a local runner that uses the user's installed CLI.
- F9. Agent builder: connector + model (live list) + role prompt + tools (MCP servers) + limits + sandbox profile.
- F10. Bring any A2A agent by URL (reads its Agent Card) or any MCP server as a tool.
- F11. Health checks per connector (auth valid, quota, latency) on a schedule and on demand.

### 5.3 Routing and execution
- F12. Router picks agent(s) per task using: task type, contract, scoreboard, cost/latency budget, user pins, data-sensitivity rules, availability.
- F13. Execution modes per task: **single**, **best-of-N** (parallel, pick winner), **ensemble-merge**, **maker–checker** (one builds, another reviews), **debate** (two argue, judge decides), **cascade** (cheap model first, escalate on failure), **pipeline** (fixed sequence of specialists).
- F14. Parallel execution across tasks with no dependency; leases prevent overlap (see 5.4).
- F15. Live streaming of each attempt: messages, tool calls, file edits, cost so far.
- F16. Pause, resume, cancel, retry with a different agent, take over manually.
- F17. Two runner modes: **cloud runner** (our containers, API keys) and **local runner** (daemon on the user's machine for local repos and locally installed CLIs).

### 5.4 Coordination between agents
- F18. **Task leases**: a task claims the files, directories, symbols, or resources its contract touches, for the life of the task (not per edit as in Relay). Overlapping leases serialize or split the work.
- F19. **Interface contracts**: when tasks depend on a shared API/schema/component, the planner creates a contract task first; dependants build against the agreed contract; contract changes trigger affected-task notifications.
- F20. **Agent messaging**: agents can ask another task's agent a question, request a review, or report a blocker through a Brio mailbox tool (exposed via MCP to CLI agents, native to API agents). Messages are events on the board.
- F21. **Handoff packets** generated automatically when work moves between agents (schema in HANDOFF_PACKET.md).
- F22. **Isolation**: every attempt works in its own git worktree / sandbox; Brio merges verified results, resolving conflicts with a dedicated merge task when needed.

### 5.5 Verification and quality
- F23. Acceptance checks run automatically: tests, typecheck, lint, build, schema validation, link checks, fact checks against sources, image spec checks.
- F24. Cross-vendor review: a different vendor's model reviews every non-trivial output against the contract using a rubric; verdict pass / revise / fail with reasons.
- F25. Best-of-N judging: pairwise comparison by a judge model (and tests) chooses the winner.
- F26. Human gates: configurable approvals at plan, task, merge, and publish steps.
- F27. Final mission report: what was done, by whom, evidence (tests, reviews), cost, time, open issues.

### 5.6 Learning
- F28. Scoreboard per workspace and global (opt-in, anonymised): agent × task type → win rate, verification pass rate, rework rate, cost, latency, user rating.
- F29. Router uses the scoreboard (Thompson sampling with cost penalty) and explains its choice in one line on each task.
- F30. User feedback (thumbs, "this agent is bad at X") updates scores.

### 5.7 Memory
- F31. Project memory graph: decisions, contracts, files, tasks, agents, prompts behind changes, user preferences. Every agent gets a brief before it starts (like Relay's session brief, but across all agents and task types).
- F32. Cross-mission memory per project; user can view, edit, forget items.

### 5.8 Governance
- F33. Budgets at workspace, mission, task, agent level (money and wall-clock); pre-dispatch cost estimate; hard stop and soft warn thresholds.
- F34. Policies: which connectors may see which data (e.g. "client code never to non-enterprise endpoints"); network allowlists per sandbox profile; irreversible-action approvals.
- F35. Audit ledger: hash-chained record of every dispatch, spend, approval, and external side effect (Mandate-compatible).
- F36. BYOK vault: per-workspace encrypted keys; usage metering per key; key rotation.

### 5.9 Surfaces
- F37. Web app (primary).
- F38. CLI: `brio run`, `brio plan`, `brio board`, `brio runner` (local runner daemon).
- F39. **Brio as an MCP server**: any agent (Claude Code, Cursor, Codex) can call `brio.delegate`, `brio.ask_agent`, `brio.get_brief`, `brio.report` — so a user inside Claude Code can say "have Gemini research this and Codex write tests" and Brio does it.
- F40. **Brio as an A2A agent**: publishes an Agent Card; other platforms (Copilot Studio, Gemini Enterprise, AgentCore) can delegate missions to it.
- F41. Public REST API + TS SDK.
- F42. Notifications: email, Slack, push for approvals, failures, completion.

### 5.10 Workspace
- F43. Organisations, members, roles (owner, admin, builder, viewer), invitations.
- F44. Projects linked to Git providers (GitHub first) or plain file workspaces.
- F45. Hosted cloud + open-source self-host (open-core, AGPL-3.0 like Mandate).

## 6. Non-goals

- Automating consumer chat apps or reusing subscription logins (legal/ToS risk, fragile).
- Training our own frontier model.
- Replacing Git; Brio sits above it.
- Being a general workflow tool for non-AI steps (we integrate Zapier/n8n/Composio instead).

## 7. Success metrics

- **Outcome quality:** on the golden-mission eval set, Brio's verified pass rate beats the best single agent by ≥15 points at ≤1.3× its cost.
- **Human time saved:** median human interventions per mission < 3.
- **Collision rate:** merge conflicts per 100 parallel tasks < 2 (vs ~28 baseline in agent-PR studies).
- **Router learning:** scoreboard-driven routing beats static routing by ≥10% on cost-adjusted pass rate after 200 missions.
- **Adoption:** weekly active missions per workspace; % missions using ≥3 vendors.

## 8. Gaps vs Relay that are explicitly in scope

| Relay gap | Brio requirement |
|---|---|
| No planning or routing | F2, F12–F13 |
| No agent-to-agent messaging | F20, F21 |
| Coding only, 5 agents via hooks | F7 catalogue across 13 categories |
| No open protocol | F39–F40 (MCP + A2A both ways) |
| No quality layer | F23–F27 |
| No learning about who's best | F28–F30 |
| No cost awareness | F33, F36 |
| Per-edit 15 s locks, import-graph only | F18–F19 task leases + contracts |
| No isolation (worktrees on roadmap) | F22 |
| Laptop-as-server fragility | Hosted API + optional local runner |
| No governance | F33–F36 |

We may still integrate Relay itself as an optional coordination backend for teams already using it.
