# Changelog

## v0.1.0 — 2026-10-24 — the first release
Everything below, M0 to M10 and what came after, released as one version:
- **Install:** `ghcr.io/ivan825/brio-{api,runner,web}:0.1.0` for amd64 and arm64; the Helm chart uses them by default, Compose with `./setup.sh --prebuilt`.
- **Versions:** every package is 0.1.0. A tag `vX.Y.Z` on a commit that passed CI adds `X.Y.Z` and `X.Y` to that commit's images.
- **The CLI on npm** (D-111): `npm install -g brio-orchestrator`, or `npx brio-orchestrator`. One bundled file with no dependencies; `brio --version`.
- **Website and docs:** <https://brio-orchestrator.vercel.app>, with every guide in this folder under `/docs`.

## 2026-10-24 — After M10: no domain needed, and a product website
- **Email from a mailbox you already have** (D-106): any SMTP server, for example Gmail with an app password, sends sign-in links, invitations and notifications. You don't need a domain or a Resend account. Resend still wins when both are set.
- **Sign-up by invitation** (D-107): with `BRIO_SIGNUP_ALLOW`, a Brio reachable from the internet (for example a laptop behind a tunnel) lets only the listed addresses, and people with a pending invitation, create accounts. Nobody else is sent a sign-in link.
- **[Owner setup](OWNER_SETUP.md):** everything step by step with free accounts only:
  - Gmail for email;
  - a public HTTPS address from Tailscale Funnel;
  - Slack and browser push;
  - Claude Code over MCP;
  - the local runner;
  - a real pull request;
  - live vendor tests;
  - a local Kubernetes cluster;
  - the website.
- **Chat** (D-109): talk to every agent you connected, the way you talk to one assistant.
  - Pick who answers and how:
    - **auto:** the best agent for it;
    - **together:** each answers, one merges;
    - **review:** one answers, another checks;
    - **debate:** they argue, and a judge decides.
  - Watch them work live, see each agent's own answer, rate it, or **turn it into a mission**.
  - Each message is a task on the mission engine, so routing, budgets, policies, checks, the ledger and the scoreboard all apply. Follow-ups carry the conversation as quoted context.
- **Refused models:** a model or key the vendor refuses is no longer retried. Planning moves to another agent, or says what to change and resumes once it's fixed.
- **Stopped tasks:** a task someone stopped now stays stopped when its attempt ends late.
- **A free server is enough** (D-110): GitHub builds Brio's images for every commit on `main` that passes its checks (amd64 and arm64) and publishes them to GitHub Packages. `./setup.sh --prebuilt` makes a server download them instead of building, so a 1 GB server (free with Azure for Students) runs Brio: measured at about 510 MB idle and 560 MB at peak while a mission runs a sandboxed task. The updater installs a commit only once its images are published, then removes the old ones.
- **Automatic server updates:** a systemd timer pulls `main` every 5 minutes, rebuilds, and clears old build layers ([Deploy on a cloud server](DEPLOY_CLOUD.md)).
- **The product website** (`apps/site`, D-108): a static page in the Brio brand. Its screenshots are of the real app, and its claims are checked by tests against the registry, the load test and the CLI. It is published to a free `*.vercel.app` address from the owner's machine, so the repository is never connected to Vercel.
- **Fixed:** Governance's daily usage bars were invisible, and its breakdowns lost their names in narrow columns. The brand check now flags opacity modifiers on brand colours, which Tailwind silently drops.

## 2026-10-24 — M10 Self-host, hardening, launch readiness
Pushed in small steps (CLAUDE.md rule 9, D-17).

**Self-hosting** ([SELF_HOST.md](SELF_HOST.md)):
- Production images for the API, runner and web app, from one Dockerfile.
- A Docker Compose bundle: Postgres, a one-shot migration, the API, a runner driving the host's Docker, the web app, and Caddy with automatic TLS.
- A Helm chart: web pods and one worker, runners each with their own Docker engine listening only on loopback, a migration hook, and an ingress.
- A smoke test that drives a fresh install through its public entry point. It passed against the Compose bundle, and against a reproduction of the Helm runner pod.
- Fixes found on the way:
  - a blank environment variable counted as set;
  - a runner in a container could not hand its worktrees to the sandbox user, or be reached by sandbox proxies;
  - a browser reopened at another size kept the old display;
  - a stale same-named container blocked a sandbox.

**Load** ([LOAD_TEST.md](LOAD_TEST.md)):
- 125 missions and 500 concurrent attempts, with API p95 136 ms and event fan-out p95 741 ms. All missions finished.
- What it took:
  - runners take jobs with one claim loop per queue: idle runners now cost Postgres 30 times less (D-100);
  - the API runs as scalable web processes and one worker (D-99);
  - events that cannot change scheduling no longer wake the orchestrator;
  - no JWT is minted per request;
  - ledger entries are chained after their transaction rather than under a workspace-wide lock (D-98);
  - hot-path indexes, and a batched inbox.

**Security** ([SECURITY_REVIEW.md](SECURITY_REVIEW.md)):
- A threat model, and two whole-surface reviews. Every finding is fixed and tested:
  - prices only from a vendor's own address (D-103);
  - work on a person's machine only from them: their missions, plans they approved, their agents and memory, their deliveries (D-101);
  - A2A for current members only, and removal revokes tokens and runners;
  - Better Auth's own workspace endpoints closed, and only owners make admins;
  - the URL guard sees through IPv6 disguises and pins connections against DNS rebinding (D-102);
  - runners authenticate in the handshake and report only their attempts' own events;
  - the ledger refuses pre-chained rows;
  - rate limits per client address.
- A sandbox escape suite against real containers.
- A prompt-injection suite. Untrusted content is fenced so it cannot close its own quote, and every result is scanned, with findings held for a person (D-104).
- `pnpm audit`: no high or critical advisories.

**Docs site:**
- `/docs` serves the repository's docs, public, with a getting-started guide, a guide to writing adapters, and an API reference generated from the routes (a test keeps it current).
- `prompts/` is kept out of the repository.

**Usage, billing hook, status (D-105, D-15 decided):**
- Brio stays bring-your-own-keys.
- Usage per workspace by day, agent, vendor and kind of task, on Governance.
- A signed daily usage hook for operators who charge for hosting Brio.
- A public `/status` page.

**Acceptance evidence:**
- A fresh install from the Compose docs ran a planned, sandboxed and checked mission end to end (about 15 minutes, mostly image builds).
- The load-test SLOs were met.
- No high or critical security findings are open.

**Not yet verified live:** a real Kubernetes cluster, and a public deployment with TLS, need the owner's infrastructure.

## 2026-10-24 — M9 Governance, memory, notifications, roles
Pushed in small steps (CLAUDE.md rule 9, D-17).
- **Budgets at every scope (D-89):** monthly limits for the workspace and each agent, plus every mission's and task's own. Before dispatch every scope must fit the estimate and the attempt is capped to what is left; while it runs a guard warns past the soft threshold and, the moment a scope is crossed, stops every running attempt in it (`limit_exceeded`) — the task waits, blocked, until a person raises the budget on the board.
- **Policy engine (D-90):** data routing by sensitivity (confidential work goes only to local models unless a policy allows a connector), connector allow and deny lists, network and approval policies — applied wherever agents are chosen and checked again at dispatch, so nothing routes around them.
- **Approvals wherever people are (D-91, D-92):** email through Resend, browser push (VAPID), and the workspace's own Slack app with Approve and Deny buttons (signed, mapped to a member by email); each event reaches each person once, by their preferences. MCP clients may decide approvals with the `brio:approve` scope a person grants on consent.
- **Ledger (D-93):** owners and admins browse it, verify the hash chain (the first broken entry is named) and export it as JSONL or CSV.
- **Project memory (D-94):** a graph built from events — missions, tasks, contracts, prompts, decisions and the files they touched. The brief for a file or topic goes to every attempt on the project and to `get_brief`; people add, correct and forget what is remembered, each change in the ledger.
- **Roles (D-95):** owner, admin, member and viewer enforced on every route; role changes follow the rules and are in the ledger.
- **Global scoreboard (D-14 → D-96):** opt-in both ways — add this workspace's outcomes, anonymised; start unseen agents from global numbers once 20 outcomes from three workspaces stand behind them.
- **Mandate (D-07 → D-97):** connect a Mandate and every paid attempt asks it for authority first, spends no more than was held, and settles the real cost; spend a person must approve waits in Mandate's inbox; unreachable means nothing paid runs.
- **Fixes found on the way:** a task that failed late could fail its whole mission; an attempt whose cap equalled what the budget had left could overspend; a local-runner test assumed a fixed delay.
- **Acceptance evidence:** a confidential task is never routed to a disallowed connector (property tests over the engine, API tests, and in the browser until a policy allows it); a budget stop halts two running attempts within 5 s of the mission crossing its budget; the brief for a changed file holds the plan's assumption, the person's answer, the contract and the prompt behind it, and the next mission's agent gets it; notifications by email, push and Slack (decided from Slack, forged requests refused); the roles matrix; ledger tamper detection; the global scoreboard's thresholds; Mandate's approve, wait-for-a-person, decline and unreachable paths against a fake following its agent API.
- **Not yet verified live:** Resend, web push in a real browser, a real Slack app and a real Mandate instance need the owner's keys and apps.

## 2026-10-24 — M8 Web app complete, CLI, local runner
Pushed in small steps (CLAUDE.md rule 9, D-17).
- **The pull request, approved (D-81):** a mission on a repository proposes its delivery when it ends — the integration branch pushed, a pull request on GitHub — and waits for a person in the inbox or on the board; approved, a runner pushes and opens the pull request as the project token's owner; denied or failed, ask again. Projects keep a git token in the vault for private repositories and pull requests (D-82); GitHub Enterprise via `BRIO_GITHUB_API_URL`.
- **Approvals inbox:** plans to approve, results to review, agents' questions and actions that need a yes, across every mission.
- **Mission composer (D-84, D-85):** project, priority, budget and time limit, routing (learned, static, a crew, one agent), planner, quick start, a template (adapted or as is), a GitHub issue link and attached files, which every agent gets.
- **Plan editor:** list and graph views; reorder, split, merge, reassign, mode (best-of-N with its N), task budgets, approval gates, add and remove tasks and dependencies — each edit a new, linted version.
- **Live board:** a task graph beside the list, a diff viewer file by file, cost by agent and task against the budget, leases held and released, the merged result with its checks and diff, the delivery card, the mission's inputs, and a link to the report page (what was done, by whom, checks, integration, what is still open; Markdown too).
- **Projects, crews and templates** pages; **settings** gain local runners.
- **CLI:** `brio login` (device flow: approve the code in the browser, D-83), `logout`, `whoami`, `workspace`, `missions`, `run` (with project, priority, budget, crew or agent, planner, template, issue, files, quick start, watch), `plan` (show and edit), `board` (live over SSE in the terminal), `approve` (plans and pull requests), `runner`.
- **Local runner (D-86, D-87):** `brio runner register` (host mode asks for consent) and `brio runner start` make your machine a runner: one outbound WebSocket, Docker or host mode, coding CLIs under your own sign-in where the vendor allows it (Antigravity; Claude Code for your own work), on projects that live there — attempts, command checks, merges and branch deliveries all run on your machine and show on the web board. API keys never leave the vault.
- **Fixes found on the way:** an agent edit reset untouched fields (zod defaults inside `partial()`); MCP delegate and the A2A server could report a quick-start mission as waiting for approval (D-88); a delivery's status and event are now one write; a failed fetch no longer wipes the runner's repository cache.
- **Acceptance evidence:** in the browser — create a mission on a repository, edit its plan, approve it, watch its sandboxed task, check and merge live, approve the pull request (pushed, opened through the GitHub API), read the report; the CLI end to end against a real server (device login, run, plan edits, approve, board to the end, logout); a local runner in host mode runs a task with a locally signed-in CLI (a stand-in `agy`), checks it there, the board sees every event, and the approved branch lands in the person's repository; delivery, inputs, crews, templates and device-flow tests against Postgres.
- **Not yet verified live:** a real signed-in `agy` or `claude` on a person's machine, and pull requests on github.com, need the owner's machine and repository.

## 2026-10-24 — M7 Protocol surfaces: MCP, A2A, ACP
Pushed in small steps (CLAUDE.md rule 9, D-17). Protocol facts verified on 24 Oct 2026 in `docs/vendors/protocols.md`.
- **Brio as an MCP server (D-75):** /mcp (streamable HTTP) with delegate, plan_mission, approve_plan, mission_status, report, ask_agent, answer, get_brief, get_contract, request_review and list_missions — any agent hands Brio a goal and gets the verified report back. `brio mcp` serves the same tools over stdio for local clients.
- **Sign-in for remote MCP clients (D-76):** OAuth 2.1 from Better Auth — protected resource and authorization server metadata, Client ID Metadata Documents and dynamic registration, PKCE, a consent page, sign-in that resumes the authorization, JWT access tokens bound to /mcp. Claude Code, Cursor and Codex can connect with nothing but the URL.
- **API tokens (D-77):** workspace-bound tokens in Settings (shown once, with ready-made lines for Claude Code, Codex and the stdio server), held to their workspace on every route.
- **Brio as an A2A agent (D-78):** an A2A v1.0 Agent Card and JSON-RPC/SSE endpoint on the official SDK; every message becomes a mission, its task follows the mission (questions and plan approvals as input-required) and ends with the report and produced files as artifacts; tasks live in Postgres and survive restarts.
- **A2A agents as workers (D-79):** install any A2A agent by URL; its card names it and its skills suggest the task types it takes (editable); questions it asks reach the mission's person.
- **MCP servers as tools (D-80):** install any MCP server by URL (checked by listing its tools), attach it to agents; model-API agents call its tools in their tool loop, coding CLIs get it in their configuration; its credential never leaves the vault except into the run's memory.
- **ACP (D-74):** coding CLIs that speak the Agent Client Protocol can be driven over it with the official SDK — opt-in per agent, Cursor first — with structured tool calls, plans, file edits and answered permission requests.
- **Acceptance evidence:** an MCP client (the official SDK, as Claude Code connects) delegates a goal over HTTP and over stdio and gets the report; the full OAuth flow in a browser (signed out → sign in → consent → code → token → MCP call); the official A2A client discovers Brio, streams a mission and reads the report artifact; Brio delegates a research task to a sample A2A agent on the official SDK, verifies its citation and relays its question; an agent calls a real MCP server's tool mid-task with the token kept out of every stored record; Cursor's adapter drives an ACP agent built on the official SDK, including cancellation.
- **Not yet verified live:** Claude Code, Cursor and Codex connecting to a deployed Brio, and Cursor's ACP mode, need a public deployment and the owner's keys.

## 2026-10-24 — M6 Hosted, browser, media and research agents
Pushed in small steps (CLAUDE.md rule 9, D-17). Vendor wire facts verified on 23–24 Oct 2026 in `docs/vendors/` (hosted agents, media, research and browsers, protocols).
- **Service connectors as data (D-62):** a `services` section in the registry (base URL with install settings, bearer/header/AWS SigV4/Entra auth, a free key check, billing unit and fixed rates, the task types each takes). One shared job runner (start, poll, answer, cancel, collect) gives every vendor the same limits, cost events, approvals and file handling.
- **Hosted agents:** Claude Managed Agents, OpenAI Agents API (hosted-browser approvals), Gemini managed agents, Jules, Devin, Manus (polled; signed webhooks when Brio is public, D-72), Bedrock AgentCore and Foundry Agent Service. Questions and approvals go to the mission's person; no answer is no (D-64). Changes come back as a patch applied to the task's worktree, so checks and integration treat them like any agent's.
- **Media:** OpenAI images and speech, Gemini Omni video and Nano Banana images, FLUX, Runway, Luma, Kling, ElevenLabs, Ideogram and Recraft. Size, aspect, duration and format come from the task's media_spec check; results are downloaded at once and placed at the contract's output path; voice reads the script a writer produced; metered in each vendor's unit (D-65).
- **Research:** Perplexity's Agent API, OpenAI web search and xAI web/X search answer with numbered sources; Gemini Deep Research runs as a managed agent. Exa, Tavily, Parallel and Brave (search) and Firecrawl and Jina (pages) are workspace tools every agent gets as `web_search` and `fetch_url` — in-process for model APIs, over MCP for coding CLIs — metered per call and never on confidential tasks (D-66).
- **Browsers:** Claude computer use (`computer_toolset_20260801`) drives Chromium on a virtual display in a new browser sandbox that reaches only the sites the task names (D-69); with `browser: cloud` it drives a Browserbase or Steel session over CDP, the allowlist enforced in the browser (D-70). Amazon Nova Act runs on the sandbox's browser through its AWS API, following the actuation protocol in Amazon's own SDK; Browser Use Cloud runs capped at the attempt's budget (D-71). A person is asked before anything irreversible; sign-ins and captchas are never done by agents.
- **Unsupported connectors** (Midjourney, Suno, Comet, consumer apps) name their legitimate alternatives in the catalogue, linked.
- **Web:** service connectors install from the catalogue with their settings and credential form (API key, AWS or Entra JSON); tools are labelled as tools and kept out of the agent builder; agent options (unit price, voice, cloud browser).
- **API tokens (M7 groundwork):** workspace-bound tokens for the CLI, MCP and A2A clients, stored as hashes, held to their workspace on every route, unable to administer workspaces or mint tokens.
- **Fixes found on the way:** tasks that work on files now start from upstream work and all of them integrate, not only code (D-68); judges, checkers and mergers only from agents that can do that work (D-73); a closed stdin pipe no longer crashes the runner; two test races on the verifying status.
- **Acceptance evidence:** contract suites with vendor fakes for every hosted, media, research, search, fetch, browser and cloud-browser adapter; the golden mission "landing page + hero image + 30-s voiceover" across at least three vendors (a model API, FLUX, ElevenLabs) passes verification and integrates; a real computer-use run in the browser sandbox; Jules end to end with its patch tested in the sandbox; Manus webhook signatures; real Chromium driven by xdotool and by CDP in the browser image.
- **Not yet verified live:** every M6 vendor needs the owner's keys for a live run (`LIVE_<VENDOR>=1`).

## 2026-10-23 — M5 Verifier, judge, merge, evals
Pushed in small steps (CLAUDE.md rule 9, D-17).
- **Verifier:** every check kind in ROUTING §4.1 runs (D-56). Decided at once: diff scope, citations, media specs (PNG, JPEG, GIF, WebP, WAV, MP3, MP4 headers) and contract conformance against a JSON Schema. In the runner: tests, typecheck, lint, build, link checks (each redirect through the URL guard), fact-check source fetching, and a11y and Lighthouse audits in a new web sandbox with no network (D-58). By agents: rubric reviews (scores per criterion), fact checks against the fetched sources and contract reviews, always from another vendor than the maker, else a person (D-57; property test over 2,000 random workspaces).
- **Verdicts:** revise twice with the failures (building on the result), reroute once to the next-best agent, then fail; a task that fails for good leads to one revised plan that keeps finished work, which carries over on approval (D-59). Judges compare both orders (M4).
- **Merge engine:** when every task is done, the finished branches merge in plan order onto an integration branch and every hard check runs on it; conflicts become merge.integrate tasks working on the conflict markers, failures fix tasks; a task whose upstream branches conflict waits for a merge task (D-60).
- **Mission report:** what was done, by whom, the evidence, cost, time, the integration and what is still open; live or final, JSON or Markdown (`GET /v1/missions/:id/report`), saved with the mission in the same transaction that ends it.
- **Evals:** 30 golden missions (bug fixes, features, test writing scored by seeded mutants, refactors, docs, summaries, data extraction) with fixed plans and hidden scorers; missions can now take a routing strategy (learned, static, one agent alone) and a supplied plan; `pnpm evals` runs every mission under each agent alone, static and learned, scores the results in a sandbox and prints the comparable metrics table with the PRD verdict (≥ 15 points over the best single agent at ≤ 1.3× its cost; learned vs static). Offline runs use simulated agents of known skill and run nightly in CI; live runs use your agents and keys (D-61). Runs can be saved for the new Evals page.
- **Fixes found on the way:** a mode's attempts were matched to their route by timestamps from two clocks (now a route id); a mission's end, its event and its report are now one transaction.
- **Acceptance evidence:** a seeded-bug repository where the wrong fix is caught by the tests and fixed on revision, and one where a failing agent is replaced and the next one fixes it; cross-vendor rubric review and fact check with links followed; an accessibility audit failing a page and passing its fix; merge conflicts, failing merged work and conflicting upstream work each resolved; a revised plan carrying finished work over; routing strategies and supplied plans; the golden set's integrity (every right answer passes its own checks and the hidden scorer, every wrong one fails); an offline eval run producing the metrics table.
- **Offline eval results (honest):** 30 golden missions with simulated agents. One pass: the strongest agent alone (coder) 73.3%, static routing 80% (its default happens to be that agent, plus revisions), learned 66.7%; PRD verdict not met offline (−6.7 points vs the best single agent at 1.26× its cost). Three passes without ratings: learned 57%, 50%, 53%. With `--feedback` (results rated by their hidden checks, as a user would): 77%, 67%, 70%. The verifier passes some wrong answers that only the hidden checks catch, so learning from verification alone cannot separate agents whose failures the contract's checks miss (D-67). Fixes made from the findings: judge ties go to the likelier-right result and mode candidates must be plausible (D-63); the eval itself had bugs, fixed (integration of non-code tasks, a merge lease left held, a wrong golden answer looping).
- **Not yet verified live:** live evals and audits against real vendors need the owner's keys (`pnpm evals --live --agents <file>`).

## 2026-10-23 — M4 Router, execution modes, scoreboard
Pushed in small steps (CLAUDE.md rule 9, D-17).
- **Learned router:** candidates filtered by capability, sensitivity, connector health and the mission's remaining budget; each one's pass rate Thompson-sampled (seeded per task, reproducible) and weighed against Elo, cost and latency by the mission's priority (quality, balanced, cheap, fast); two warm-up tries per new agent and task type (D-51). Every routed task gets a `task.routed` event and a one-line rationale on the board ("codex chosen: 81% pass rate on code.feature (n=41), $0.31 avg, beats claude-code on cost at similar quality").
- **Execution modes:** single, best-of-n (different vendors, tests decide, an outside judge breaks ties in both orders), ensemble (a merger reconciles), maker–checker (a reviewer from another vendor; revise up to twice), debate (two proposals, a judge, a merge), cascade (cheapest first, escalate on a failed check) and pipeline (agents in order, set in the plan editor). Default rules per task type and priority (ROUTING §3.2); the plan editor's `mode` edit chooses on purpose (D-55). Modes degrade to single with a reason when there are too few agents, vendors or budget, so Brio works with 1, 2 or many agents (D-52, D-53).
- **Scoreboard:** Beta pass rate (a revise counts half), cost and latency EMAs, Elo from judges, 60-day decay, new models inherit their vendor's prior at weight 5; one outcome per attempt (D-54); `score_history` for trends. `GET /v1/scoreboard` (filters by task type and vendor, trend per row) and `POST /v1/attempts/:id/rating` (thumbs up/down, once per person).
- **Web:** rationale and degraded-mode notes on task cards; attempts show their role (make, review, judge, merge) and which one was chosen; ratings; the Scoreboard page with filters and pass-rate sparklines.
- **Acceptance evidence:** simulation tests (synthetic agents of known quality and cost; the router converges to the best-utility agent within 50 tasks per type for every priority, over 200 seeds); a pure test per mode; an integration test per mode through the orchestrator with scripted vendors and Docker sandboxes (best-of-n judged in both orders with Elo moving, maker–checker with a revision, debate merged into the contract, ensemble accepted by a person, cascade escalating past a failed test, a pipeline from the plan editor); Playwright (rationale on the board, a rating, the scoreboard).
- **Not yet verified live:** the golden mission with modes on real vendors needs the owner's keys (`LIVE_GOLDEN=1`, see `apps/api/test/live-golden.test.ts`).

## 2026-10-23 — M3 Missions, planner, DAG engine, coordination
Pushed in small steps (CLAUDE.md rule 9, D-17).
- **Planner:** a mission's planning task is dispatched to a model-API planner with the goal, the agents' abilities, the budget and (with a project) the repository's file list; its JSON is validated, retried with the errors, and linted: cycles, missing checks, contract consumers made to wait for the contract, parallel code tasks with overlapping files serialised, estimates and the critical path (D-44). Up to 3 questions; answers and change requests replan.
- **Plan editor and versions:** edit (update, add, remove, split, merge, depend, budget, approval gate, pin an agent), each edit a new linted version; approve; replan with notes.
- **Scheduler:** a pure decision function over the mission's state, applied with conditional updates by an orchestrator that reacts to every event and sweeps active missions, so a crash or restart resumes where the database says; parallel tasks up to a cap.
- **Leases:** exclusive per path or glob, granted under a workspace lock, renewed while working, released at the end (D-46).
- **Static router:** pin, else a coding CLI for code and a model API for the rest; adapts to 0, 1 or many agents and degrades multi-agent modes honestly.
- **Verifier (M3 part):** command checks in a fresh sandbox, diff scope, and people for the rest; revise up to twice with the failures, then fail (D-45). People accept, send back or fail tasks waiting for them.
- **Handoffs and contracts:** a packet per dependent task with done items, decisions (carried down the chain, D-48), artifacts, contracts, check evidence, risks and next steps, written into `.brio/handoff.json` and the prompt; design tasks register versioned contracts, and a changed contract notifies its running consumers.
- **Mailbox:** ask_agent, inbox, answer, blockers, review requests, contracts and the brief, for model-API agents in-process and for coding CLIs as an MCP server through the sandbox proxy (D-43); people answer questions addressed to them.
- **Projects:** `/v1/projects` with https git URLs (local paths when allowed, D-50); tasks start from their upstream tasks' merged branches (D-47).
- **Web:** plan panel (lint, fixes, assumptions, questions, agent per task, approve, replan), live task graph with blocked reasons and revisions, reviews, questions waiting for you; the stub planner is gone (D-49).
- **Golden mission:** `apps/evals/golden/oauth-login` (sample Next.js app with node-run tests) and a live run behind `LIVE_GOLDEN=1`.
- **Acceptance evidence:** crash-resume test written first (four-task mission with a contract task, two vendors running in parallel, no overlapping leases, handoffs to the docs task, a command check passing in a sandbox, the API killed and restarted mid-mission and the mission completing); ask_agent test (a question reaches the other running task and the answer returns, on the event trail); a coding CLI reaching the mailbox over MCP from its sandbox; pure tests for lint, edits, routing with 0/1/2+ agents, scheduling and handoffs; Playwright (plan → approve → run → review → done).
- **Not yet verified live:** the golden mission with real agents needs the owner's keys.

## 2026-10-23 — M2 Runner and coding CLIs
Pushed in small steps (CLAUDE.md rule 9, D-17).
- **Runner:** `apps/runner` consumes attempt jobs from pg-boss, claims each atomically, heartbeats it, honours cancel within seconds (Postgres NOTIFY plus the heartbeat), and reaps attempts whose runner died and jobs that were lost. The API now resolves a dispatch plan per attempt and queues it (D-38).
- **Sandboxes:** one container per attempt from the profiles in ARCHITECTURE §5 (chosen by pure logic in `@brio/core`): non-root, read-only root, writable worktree and tmp only, no capabilities, CPU/memory/PID limits, no Docker socket. Network is none, or an internal network whose only exit is a per-attempt egress proxy that forwards to allow-listed hosts and never to private or metadata addresses (D-39). Images are built from `apps/runner/images` and tagged by a hash of their source.
- **Worktrees and artifacts:** a git worktree per attempt on `brio/<mission>/<task>/<attempt>`, from the project repository or an empty one; results committed from the runner's own repository with hooks and agent config ignored (D-40); diff and changed files stored content-addressed with sha256; output containing a secret is stored redacted and quarantined.
- **Coding CLIs:** `CliAdapterBase` and adapters for Claude Code, Codex, Cursor Agent, Antigravity, OpenCode, Aider and Goose, each flag verified against the CLI's own `--help` in the sandbox image (D-36, D-42); keys only through the environment; prompts too long for argv handed over as a file; Antigravity judged by its result event (issue 548); Cursor unmetered (D-37).
- **API models code too:** model-API agents on code and data tasks get a network-less sandbox with read, write, list and run tools.
- **API and web:** CLI connectors installable with their vendor's key; artifact listing and safe content serving; the board shows queued/running attempts, sandbox profile, file edits and the diff.
- **Acceptance evidence:** Docker integration tests (an API model writes a function and its test and `node --test` passes inside the sandbox; a CLI through the base produces a diff; cancel kills process and container in under 10 s; a cost breach ends with `limit_exceeded`; a sandbox cannot reach a non-allow-listed host or the metadata address; a key printed by the agent never reaches events or logs and secret-bearing output is quarantined; the reaper fails lost attempts); worktree safety tests (a booby-trapped `.git` never runs on the host); fixture tests for every CLI; API dispatch tests; Playwright.
- **Not yet verified live:** real CLI runs need the owner's keys (`pnpm --filter @brio/runner test:live`).

## 2026-10-23 — M1 Connectors and model APIs
Pushed in small steps (CLAUDE.md rule 9, D-17).
- **Registry:** `@brio/registry` validates `registry/connectors.json` (98 connectors, 13 categories with task types), looks up capable connectors by task type, and fails CI when a planned P0/P1 connector has no adapter. Vendor presets are data (D-27): 18 presets (OpenAI, Anthropic, Gemini, xAI, Meta, Mistral, DeepSeek, Kimi, GLM, Qwen, Sarvam, OpenRouter, LiteLLM, Ollama, vLLM, Groq, Together, Fireworks), each checked against the vendor's docs on 23 Oct 2026.
- **Adapters:** `AgentAdapter` (ADAPTER_SPEC §1, D-31), the contract suite (health, model list, estimate, hello task, tool loop, cancel, time and cost limits, vendor errors and retries, credential redaction), and three families over native HTTP (D-28): `openai-compatible` (Responses and Chat Completions), `anthropic` (Messages with prompt caching, thinking blocks echoed), `gemini` (generateContent with thought signatures). One internal tool loop for all; sandbox file tools fail closed until M2, search and mailbox tools are typed interfaces offered only when backed. Every request passes a URL guard (D-32). Live tests per vendor behind `LIVE_<VENDOR>=1`.
- **Metering:** cost maths in `@brio/core` (cache reads and writes, reasoning, long-context tiers, DeepSeek off-peak, micro-dollar rounding); `model_prices` seeded from `registry/prices.json` and refreshed live from OpenRouter and vendor model lists; vendor-reported cost preferred (OpenRouter, xAI, LiteLLM); a run with no known price is refused (D-30). An `attempt.cost` event per model call, a `spend` ledger entry per attempt.
- **API:** catalogue (`/v1/registry`), connectors (keys into the vault, health check, live model list, rotate, remove), agents (connector + model + role prompt + limits + optional price), direct task runs with cancel and output (D-29), pricing list and refresh; attempts orphaned by a restart are marked failed.
- **Web:** connector catalogue grouped by category with route chips, status, tier, search and "available now"; add-key form per preset (regions, base URL, API style), health and live model lists with prices; agent builder; Run task on the mission board with live cost, attempt status and the stored answer.
- **Database:** `connector_models`, `model_prices`, `blobs` (D-35); agents gain `price_override` and `options`; ledger kinds `connector.added` / `connector.removed`.
- **Acceptance evidence:** contract suite green for every family and API style, request wiring and free key checks for all 18 presets, API integration test (keys for four vendors incl. a bad one, health, live lists, agents, metered run with cost within 2% of usage, cancel, unknown price refused, restart recovery, keys absent from logs/events/ledger), Playwright (catalogue, add key → models → agent → run → cost and answer on the board).
- **Not yet verified live:** runs against real vendors need the owner's keys (`pnpm --filter @brio/adapters test:live`).

## 2026-10-23 — M0 Foundation
Pushed in small steps (CLAUDE.md rule 9, D-17).
- **Repo and tooling:** pack moved to the repo root; pnpm workspaces + Turborepo, strict TypeScript 6 (D-18), Biome, Vitest, Playwright; GitHub Actions CI (typecheck, lint, unit + integration tests against Postgres, migrations on an empty database, schema drift check, e2e).
- **Brand:** `@brio/brand` mirrors `brand/` byte for byte, maps shadcn/ui variables onto Brio tokens, and a test fails on any colour literal or Tailwind default-palette class outside the package (rule 10). Tailwind 3.4 LTS (D-19).
- **Web:** Next.js 16 shell in the Brio brand (dark default, light toggle, Geist, `brio_` wordmark with a cursor that blinks while anything runs, icons/manifest/OG), magic-link and passkey sign-in, workspace switcher, settings with members and invitations, missions list, live mission board over SSE.
- **Schema:** Zod schemas for every M0 entity, task taxonomy v1 and event types, kept in sync with the docs by tests.
- **Database:** Drizzle schema for all 32 tables, pgvector, append-only triggers on `events` and `ledger`, idempotent seed, docker compose Postgres on port 5433.
- **Vault:** envelope encryption (AES-256-GCM data keys, local or AWS KMS KEKs, rotation), `SecretValue`, and the redactor (tests written first) wired into logs, events and the ledger.
- **Events and ledger:** gapless per-mission `seq`, LISTEN/NOTIFY fan-out, resumable streams (D-22); per-workspace hash-chained ledger whose tamper tests were written first (D-21).
- **API:** Fastify with Better Auth (magic link, passkeys, Google when configured, organisations as workspaces, D-23), workspace CRUD/switch/invite, `POST /v1/missions` with the fail-closed stub planner (`TODO(milestone-3)`), SSE with Last-Event-ID resume and connection rotation (D-25).
- **Acceptance evidence:** API integration tests (sign-in, create/invite/accept/switch, missions → events, SSE resume, planted secret absent from logs/events/ledger) and Playwright (brand, every screen, full invite flow, live board with resume across reconnects).

## 2026-10-23 — Build pack
- Planning session output: PRD, architecture, adapter spec, routing and quality design, security and governance, handoff packet spec, decisions, build plan, connector registry (98 entries), milestone prompts.
- Product named Brio (D-13). Brand added: `brio_` logo set, dark-first tokens, Tailwind preset, BRAND.md.
