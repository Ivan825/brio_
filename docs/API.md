# API reference

Generated from the route definitions in `apps/api/src` by `pnpm --filter @brio/api docs:api`; do not edit by hand.

Every request is made as a signed-in person (the session cookie the web app uses) or with an API token
(`Authorization: Bearer brio_pat_…`, bound to one workspace). Requests act in the workspace named by the
`x-brio-workspace` header, else the session's active one. Bodies and responses are JSON; errors are
`{ "error": code, "message": text }` with the HTTP status. Live events are Server-Sent Events
(`GET /v1/missions/:id/events`, resumable with `Last-Event-ID`). Sign-in and OAuth for MCP clients are Better
Auth's routes under `/api/auth`; Brio's MCP server is at `/mcp` (tools listed in `docs/ARCHITECTURE.md`).

**Who** lists the workspace roles a route requires (owner, admin, member, viewer); *any member* includes
viewers. Routes marked *signed-in person only* refuse API tokens.

## agents

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/v1/agents` | any member | The workspace's agents: connector, model, price, limits, options, the task types they take and whether they can run now. |
| POST | `/v1/agents` | owner, admin, member | Makes an agent from an installed connector and a model (with its price, limits, options, role prompt, tools and runner). |
| PATCH | `/v1/agents/:id` | owner, admin, member | Changes an agent; only the fields sent change. |
| DELETE | `/v1/agents/:id` | owner, admin, member | Removes an agent; its past attempts and scores stay. |

## approvals

Approvals and deliveries (BUILD_PLAN M8, CLAUDE.md rule 6): a person approves or denies an action that waits on them (opening a pull request, pushing a branch); a member can ask again for a mission's delivery after one was denied or failed.

| Method | Path | Who | What |
|---|---|---|---|
| POST | `/v1/approvals/:id/decide` | owner, admin, member; signed-in person only (no API token) | Approves or denies an action waiting on a person (a push, a pull request); approved, a runner carries it out. |
| GET | `/v1/missions/:id/deliveries` | any member | A mission's deliveries (its branch pushed, its pull request) and their approvals. |
| POST | `/v1/missions/:id/deliveries` | owner, admin, member | Ask for a delivery again (the last one was denied or failed); it waits on an approval like the first. |

## attempts

| Method | Path | Who | What |
|---|---|---|---|
| POST | `/v1/tasks/:id/attempts` | owner, admin, member | Runs one task now with the chosen agent (a user action, so it is the approval for this dispatch). |
| GET | `/v1/tasks/:id/attempts` | any member | A task's attempts, newest first, with their status, cost, checks and agent. |
| POST | `/v1/attempts/:id/cancel` | owner, admin, member | Stops an attempt: a queued one at once, a running one through its runner. |
| GET | `/v1/attempts/:id/artifacts` | any member | What an attempt produced: its report, files, diff and media. |
| GET | `/v1/artifacts/:id/content` | any member | An artifact's bytes. Text is always served as text/plain (never rendered as HTML), anything else as a download: agent output is untrusted content. |
| GET | `/v1/attempts/:id/output` | any member | The agent's answer, stored as a report artifact. |

## budgets

Budgets (M9, SECURITY_GOVERNANCE §5): the workspace's and each agent's monthly limits, and a mission's own, with what is spent now. Raising a mission's budget lets the tasks a spent budget stopped run again.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/v1/budgets` | any member | The workspace's and its agents' monthly budgets, with this month's spend for each agent. |
| PUT | `/v1/budgets` | owner, admin | Sets the workspace's or an agent's monthly limit (USD) and warning threshold; null removes it. |
| PUT | `/v1/missions/:id/budget` | owner, admin, member | A mission's budget, raised or set: tasks a spent budget stopped run again. |

## connectors

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/v1/connectors` | any member | The workspace's installed connectors with their health and settings (never their keys). |
| POST | `/v1/connectors` | owner, admin | Installs a connector: the key goes to the vault, the dispatchable config to the row, then a health check runs. |
| PATCH | `/v1/connectors/:id` | owner, admin | Renames a connector, replaces its key, disables it or changes the task types it takes. |
| DELETE | `/v1/connectors/:id` | owner, admin | Soft-deletes the connector and its agents, and destroys the stored key. |
| POST | `/v1/connectors/:id/health` | owner, admin, member | Checks a connector against its vendor now (a free call where the vendor has one). |
| GET | `/v1/connectors/:id/models` | any member | The connector's models: cached, or live with ?refresh=true (and on first use). Prices attached where known. |

## crews

Crews (PRD glossary): a saved set of agents and routing preferences ("my coding crew"). A mission routed to a crew uses only its agents, and the crew's preferred agent for a task type unless the plan pins another.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/v1/crews` | any member | The workspace's crews: saved sets of agents, with an agent per task type. |
| POST | `/v1/crews` | owner, admin, member | Makes a crew. |
| PUT | `/v1/crews/:id` | owner, admin, member | Replaces a crew's agents and pins. |
| DELETE | `/v1/crews/:id` | owner, admin, member | Removes a crew; missions routed to it keep the agents they had. |

## evals

Golden-mission eval runs (BUILD_PLAN M5) for the evals dashboard: the harness saves a run (or a person uploads its results file), and the web app lists them with their metrics tables.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/v1/evals/runs` | any member | The workspace's eval runs (golden missions), newest first, with their verdicts. |
| GET | `/v1/evals/runs/:id` | any member | One eval run: each golden mission's result per strategy, cost and time, and the verdict. |
| POST | `/v1/evals/runs` | owner, admin, member | Records a finished eval run (the harness, `pnpm evals`, uploads its results, summaries and verdict). |

## health

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/health` | public | Liveness and database reachability: `{ ok, db }`. |
| GET | `/v1/auth/providers` | public | Which sign-in methods this deployment offers, so the web app only shows working buttons. |

## inbox

The approvals inbox (M8): everything in the workspace waiting for a person, across missions — plans to approve, results to review, questions and blockers from agents, and actions that need a yes (a pull request to open).

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/v1/inbox` | any member | Everything in the workspace waiting for a person, oldest first: plans to approve, results to review, agents' questions, actions to allow. |

## ledger

The audit ledger (M9, SECURITY_GOVERNANCE §8): the workspace's hash-chained record of spend, decisions, keys, policies and side effects — read page by page, verified end to end (anyone can check that nothing was changed, removed or inserted), and exported for auditors as JSON Lines or CSV. Owners and admins only.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/v1/ledger` | public | Newest first, a page at a time (`before` a seq). |
| GET | `/v1/ledger/verify` | public | Recomputes every hash from the first entry: whether the chain is whole, or where it breaks. |
| GET | `/v1/ledger/export` | public | The whole ledger as JSONL or CSV (`?format=`), for auditors. |

## mandate

Connecting the workspace's Mandate (D-07): its URL and one mandate's agent token, checked with Mandate and kept in the vault. From then on every paid attempt asks that mandate first (see ../mandate.ts).

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/v1/integrations/mandate` | any member | The workspace's Mandate connection, live state from Mandate, and recent spend holds. |
| PUT | `/v1/integrations/mandate` | owner, admin; signed-in person only (no API token) | Connects a Mandate: its URL and a USD mandate's agent token (checked with Mandate, kept in the vault). |
| DELETE | `/v1/integrations/mandate` | owner, admin; signed-in person only (no API token) | Disconnects: attempts stop asking Mandate. Requests still waiting are dropped; their tasks are freed. |

## memory

Project memory for people (PRD F32, M9): what Brio remembers about a project — view and search it, add a preference or fact, correct an item, or forget it (its links go with it). Every change by a person is in the ledger. And the brief an agent would get for some files or a topic.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/v1/projects/:id/memory` | public | What a project remembers, by kind (decisions, contracts, prompts, files, preferences). |
| GET | `/v1/projects/:id/brief` | public | The brief for paths (`?paths=`) or a topic (`?topic=`): the decisions, contracts and prompts behind them. |
| POST | `/v1/projects/:id/memory` | public | Adds something for the project to remember (a preference, a decision). |
| PATCH | `/v1/memory/:id` | public | Corrects a remembered item. |
| DELETE | `/v1/memory/:id` | public | Forgets an item: it and its links are gone, and no brief carries it again. |

## messages

The mission's mailbox as people see it: agents' questions, blockers and review requests, and the user's answers. Also a person's verdict on a task waiting for review.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/v1/missions/:id/messages` | any member | A mission's messages: agents' questions and answers, blockers and review requests. |
| POST | `/v1/messages/:id/answer` | owner, admin, member | A person answers a question (or closes a blocker) addressed to the user. |
| POST | `/v1/tasks/:id/review` | owner, admin, member | A person's verdict on a task waiting for review (human checks; the M5 check kinds until the verifier). |

## missions

| Method | Path | Who | What |
|---|---|---|---|
| POST | `/v1/missions` | any member | Creates a mission and starts planning it: a planning task (plan version 0) is dispatched to a planner agent, whose answer becomes plan v1 for the user to edit and approve (or approved automatically when allowed and small). |
| GET | `/v1/missions` | any member | The workspace's missions, newest first, with status, cost and progress. |
| GET | `/v1/missions/:id/report` | any member | The mission report: live while it runs, the final snapshot once it ends. `?format=md` returns Markdown. |
| GET | `/v1/missions/:id` | any member | A mission with its latest plan and tasks. |
| GET | `/v1/missions/:id/events` | any member | Server-Sent Events for one mission. Resumes after the Last-Event-ID header (sent by EventSource on reconnect) or the `lastEventId` query parameter; reads always come from the events table, so there are no gaps or duplicates. |

## notifications

Notifications and approvals beyond the web app (M9): each person's preferences, their browsers' push subscriptions, the workspace's Slack app, and Slack's callback when someone presses Approve or Deny.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/v1/notifications/prefs` | any member | Your notification channels and kinds, and what the workspace has connected (email, push, Slack). |
| PUT | `/v1/notifications/prefs` | any member | Sets which channels and kinds of events reach you. |
| POST | `/v1/notifications/push` | any member; signed-in person only (no API token) | A browser asks to be notified (web push); the same endpoint again just refreshes its keys. |
| DELETE | `/v1/notifications/push` | any member | Removes this browser's push subscription. |
| GET | `/v1/notifications` | any member | What Brio has sent the caller lately in this workspace (and channel messages). |
| PUT | `/v1/integrations/slack` | owner, admin; signed-in person only (no API token) | Connects the workspace's own Slack app: its bot token and signing secret go to the vault. |
| DELETE | `/v1/integrations/slack` | owner, admin; signed-in person only (no API token) | Disconnects the workspace's Slack app. |

## plans

Plan editor API (BUILD_PLAN M3): versions, edits (each a new version with lint), approve, and replan with notes.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/v1/missions/:id/plans` | public | Every version of a mission's plan, oldest first, with its lint and approval. |
| POST | `/v1/missions/:id/plans/:version/edits` | public | Applies edits to the latest proposed version and stores the result as the next version. |
| POST | `/v1/missions/:id/plans/:version/approve` | public | Approves a plan version; its tasks start. |
| POST | `/v1/missions/:id/replan` | public | Rejects the proposal and plans again with the user's notes (answers to the planner's questions, changes). |
| POST | `/v1/missions/:id/cancel` | public | Cancels a mission and stops its running attempts. |

## policies

Policies (M9, SECURITY_GOVERNANCE §4): data routing by sensitivity, the connector allow-list, network rules and quick-start limits. Owners and admins write them; every change is in the ledger. They take effect at once: the router and every dispatch read them.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/v1/policies` | any member | The workspace's policies (data routing, connector allow and deny lists, network, approvals). |
| POST | `/v1/policies` | owner, admin | Adds a policy. |
| PATCH | `/v1/policies/:id` | owner, admin | Changes or disables a policy. |
| DELETE | `/v1/policies/:id` | owner, admin | Removes a policy. |

## pricing

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/v1/pricing` | any member | Known model prices, with where each came from. |
| POST | `/v1/pricing/refresh` | any member | Pulls live prices now. Prices are public data; any workspace admin may refresh them. |

## projects

Projects: the repository a mission works on. A git URL (https) in the cloud; a local path too when the deployment allows it (self-host, local development), because the runner clones it from its own disk.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/v1/projects` | any member | The workspace's projects: repository, branch, local runner and settings. |
| POST | `/v1/projects` | owner, admin, member | Makes a project from a repository URL (or a path on a local runner). |
| PATCH | `/v1/projects/:id` | owner, admin | Changes a project's repository, branch, git token, GitHub repository or runner. |

## registry

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/v1/registry` | any member | The connector registry: every connector, preset and service Brio knows, with how to connect it. |

## runners

Local runners (BUILD_PLAN M8): a person registers their machine for a workspace (`brio runner register`), gets a token shown once, and starts the daemon with it. Host mode — no container — needs the owner's explicit consent, recorded with its words and time. Agents and projects are then bound to the runner.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/v1/runners` | any member | The workspace's local runners (not revoked), their owners, modes and whether they are connected. |
| POST | `/v1/runners` | owner, admin, member; signed-in person only (no API token) | Registers a local runner and returns its token once (host mode needs the owner's consent). |
| DELETE | `/v1/runners/:id` | owner, admin, member; signed-in person only (no API token) | Revoking stops the runner at once: its connection is refused from the next hello on. |

## scoreboard

The scoreboard (ROUTING §5): who wins at which task type, at what cost and speed, with a trend per row; and people's thumbs up/down on attempts, which feed the same scores.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/v1/scoreboard` | any member | Who wins at what: pass rate, Elo, cost and speed per agent and task type, with trends (`?taskType=&vendor=&days=`). |
| GET | `/v1/scoreboard/sharing` | any member | Whether this workspace adds to, and starts from, the global scoreboard (D-14). |
| PUT | `/v1/scoreboard/sharing` | owner, admin | Whether the workspace adds to, and starts from, the global scoreboard (D-14). |
| GET | `/v1/scoreboard/global` | any member | The global scoreboard: anonymised outcomes from every workspace that shares them. Only rows with enough outcomes from enough workspaces are shown, and nothing says which workspaces those were. |
| POST | `/v1/attempts/:id/rating` | owner, admin, member | A person's thumbs up or down on an attempt: +0.5 α or +1 β for its agent on the task's type (once per person). |

## templates

Templates (PRD F5): a plan saved as a reusable pipeline ("Research → memo → deck"). Saved from a mission's plan or written directly; a new mission starts from one, adapted to its goal by the planner or proposed as is.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/v1/templates` | any member | The workspace's mission templates. |
| POST | `/v1/templates` | owner, admin, member | Saves a template: a mission's plan (`fromMission`) or a plan given (`graph`). |
| DELETE | `/v1/templates/:id` | owner, admin, member | Removes a template. |

## tokens

API tokens (M7): a person makes one for a workspace in the web app and gives it to the brio CLI, its stdio MCP server or an A2A client. The token is shown once; Brio keeps its sha256. Only a signed-in person (never a token) makes or revokes tokens, and only their own.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/v1/tokens` | any member | The caller's own tokens in the workspace (never the tokens themselves). |
| POST | `/v1/tokens` | owner, admin, member; signed-in person only (no API token) | Makes an API token for this workspace; its value is shown once. |
| DELETE | `/v1/tokens/:id` | any member; signed-in person only (no API token) | Revokes an API token. |

## workspaces

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/v1/workspaces` | any member | Workspaces the caller belongs to, with their role and which one is active. |
| POST | `/v1/workspaces` | any member; signed-in person only (no API token) | Creates a workspace (Better Auth organisation), makes the caller owner and switches to it. |
| PATCH | `/v1/workspaces/:id` | owner, admin | Renames a workspace. |
| DELETE | `/v1/workspaces/:id` | owner; signed-in person only (no API token) | Soft delete: events and the ledger are append-only, so a workspace's history is kept. Owner only. |
| POST | `/v1/workspaces/:id/activate` | any member; signed-in person only (no API token) | Switches the session's active workspace. |
| GET | `/v1/workspaces/:id/members` | any member | A workspace's members and their roles, and pending invitations. |
| POST | `/v1/workspaces/:id/invitations` | owner, admin; signed-in person only (no API token) | Invites by email. M0 "sends" by logging the email locally (see LogMailer). |
| PATCH | `/v1/workspaces/:id/members/:userId` | owner, admin; signed-in person only (no API token) | Changes a member's role (M9). Owners and admins change members and viewers; only an owner makes or unmakes owners and admins; a workspace always keeps an owner. Recorded in the ledger. |
| DELETE | `/v1/workspaces/:id/members/:userId` | owner, admin; signed-in person only (no API token) | Removes a member (owners and admins; an admin cannot remove an owner or another admin; an owner always stays). |

## a2a

Brio as an A2A agent (ARCHITECTURE §4.6, PRD F40; docs/vendors/protocols.md §1): an Agent Card at /.well-known/agent-card.json and a JSON-RPC endpoint at /a2a (A2A v1.0, with SSE streaming), built on the official SDK's request handler. Every message an agent sends becomes a mission in the caller's workspace; the A2A task follows the mission (working → input-required for a plan to approve or a question → completed with the report as an artifact) and is kept in Postgres, refreshed from the mission whenever it is read, so it survives restarts. Callers authenticate with a workspace API token.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/.well-known/agent-card.json` | public | Brio's A2A Agent Card: its skills and the JSON-RPC endpoint. |
| POST | `/a2a` | owner, admin, member | A2A JSON-RPC: send a message (a goal becomes a mission), follow a task, answer it, cancel it. API token required. |
