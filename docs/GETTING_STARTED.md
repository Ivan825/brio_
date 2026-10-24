# Getting started

Brio takes one goal, plans it into tasks with contracts, sends each task to the agent best placed to do it, checks the results across vendors, and hands you the verified outcome. You bring the agents: your own API keys, the coding CLIs you are signed in to, hosted agents, or any A2A agent.

This page takes you from nothing to a finished mission in about ten minutes. To run Brio yourself first, see [Self-hosting](SELF_HOST.md), [Deploy on a cloud server](DEPLOY_CLOUD.md) to have it always on, or [Owner setup](OWNER_SETUP.md) for a step-by-step install on your own computer with free accounts only.

## 1. Sign in and make a workspace

Open Brio and sign in with Google or an emailed link. Create a workspace: everything (agents, missions, budgets, the audit ledger) belongs to one. Invite people from **Settings** as owners, admins, members or viewers ([roles](SECURITY_GOVERNANCE.md)).

## 2. Connect at least one agent

**Connectors** lists everything Brio can drive: model APIs, coding CLIs, hosted agents, browser agents, media models, research tools and local models. Pick one and add its key. Keys go into the workspace's vault and never appear again, not even to you.

Then make an **agent** from it on **Agents**: a model, a price (filled in from the vendor where known), limits, and optionally a role prompt and tools.

**How many agents?**
- **One agent works.** Brio plans, runs and checks everything with it, and its reviews say honestly that they come from the same vendor.
- **Two or more from different vendors** let Brio do what it is built for: route each task to whoever is best at it, have another vendor review the result, and learn from every verdict ([routing and quality](ROUTING_AND_QUALITY.md)).

## 3. Run a mission

On **Missions**, describe the goal in a sentence or two, for example *"Add a /health endpoint to the API with a test"*. Optionally choose:
- a **project** (a repository);
- a **priority** (cheaper, balanced, or faster);
- a **budget**;
- **files** or a **GitHub issue** link.

Brio plans the mission. You see the tasks, each with its contract (what goes in, what comes out, how it is checked), the agent it would go to and the estimated cost. Edit anything: reorder, split, merge, pin an agent, add a check. Then **Approve plan**. Small, cheap plans can start on their own with **quick start**.

## 4. Watch it, then take the result

The mission's board is live:
- each task's attempts, as they happen;
- agents asking each other, and you, questions;
- checks passing or sending work back;
- the cost against your budget;
- the merged result.

Anything that needs you lands in your **Inbox**: a plan to approve, a question, a result to review, a pull request to open. You can also get these by email, browser notification or Slack (**Settings**).

When the mission is done you get its report: what was done, by whom, which checks passed, and what is still open. On a repository it also proposes a pull request, which opens once you approve it.

## 5. Keep going

- **Scoreboard:** who wins at which kind of task, at what cost and speed. Brio routes by it, and it improves with every mission.
- **Governance:**
  - monthly budgets per workspace and per agent;
  - policies (where confidential work may go, which connectors may be used, network rules);
  - the hash-chained audit ledger;
  - optionally your Mandate.
- **Projects:** what Brio remembers about each repository, so that the next agent knows why the code is the way it is.
- **Crews and templates:** saved teams of agents, and missions you run often.

## Other ways in

| From | How |
|---|---|
| Terminal | `brio login`, then `brio run "your goal"` and `brio board` (`apps/cli`) |
| Claude Code, Cursor, Codex and other MCP clients | Add Brio's MCP server (`<your Brio>/mcp`); the client signs you in with OAuth, then `delegate` hands Brio a goal and returns the verified report |
| Any A2A agent | Brio is an A2A agent: its card is at `/.well-known/agent-card.json`; use an API token from **Settings** |
| Your own code | The REST API ([API reference](API.md)) with an API token |
| Your own machine | `brio runner register`, then `brio runner start`: tasks on projects that live on your machine run there, under your own CLI sign-ins (only work you start and approve) |

## Next

- [Connectors](CONNECTORS.md): everything Brio can drive, and how each connects.
- [Writing an adapter](ADAPTERS.md): add an agent or a model Brio does not know yet.
- [Architecture](ARCHITECTURE.md): how it fits together.
- [Security](SECURITY_GOVERNANCE.md): vendor terms, sandboxes, data routing, budgets, approvals, the ledger.
