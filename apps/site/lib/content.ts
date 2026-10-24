// Everything the site says, as data: the tests check it against the repository (agent names against the connector
// registry, numbers against the load test, links against the docs), so the page cannot claim what Brio does not do.

export const REPO = "https://github.com/Ivan825/brio_";
export const doc = (name: string) => `${REPO}/blob/main/docs/${name}`;

/** A sample of what Brio drives, by the names in registry/connectors.json. */
export const AGENTS = [
  "Claude Code",
  "OpenAI Codex",
  "Cursor Agent",
  "Google Antigravity",
  "Gemini CLI",
  "Jules",
  "Devin",
  "Grok Build",
  "Claude Managed Agents",
  "OpenAI Agents API",
  "Manus",
  "Local models",
] as const;

/** The size of registry/connectors.json (checked by test). */
export const CONNECTOR_COUNT = 98;

/** From docs/LOAD_TEST.md (checked by test): one laptop, 2 API web processes, 1 worker, 8 runners. */
export const MEASURED = [
  {
    value: "125",
    unit: "missions",
    label: "running at once, every one finished",
    source: "Missions done | 125 / 125",
  },
  { value: "492", unit: "attempts", label: "in sandboxes at the same time", source: "492 of 500" },
  { value: "136", unit: "ms", label: "API p95 under that load (target 300)", source: "**136**" },
  { value: "741", unit: "ms", label: "p95 from event written to your screen", source: "**741**" },
] as const;

export const BY_HAND_VS_BRIO = [
  ["Choosing the agent", "Habit, or whoever you pay for", "Scored per task type on cost, speed and verdicts"],
  ["Handing work over", "Copy and paste between chats", "Handoff packets with a contract per task"],
  ["Two agents, one repository", "They overwrite each other", "Task leases and a worktree per attempt"],
  ["Checking the result", "You read every diff", "Tests, typecheck, another vendor's review, a judge"],
  ["Cost", "You find out at the end of the month", "A budget checked before every dispatch"],
  ["What happened", "Scrollback", "Every action an event, in a hash-chained ledger"],
] as const;

export const STEPS = [
  {
    key: "plan",
    title: "Plan",
    body: "Your goal becomes a graph of tasks. Each has a contract: what goes in, what comes out, how it is checked. Edit any of it before you approve.",
    line: "plan v1 · 5 tasks · est $1.84 · awaiting approval",
  },
  {
    key: "route",
    title: "Route",
    body: "Each task goes to the agent best placed for it, across vendors, by what it has won before at that kind of task, its price and speed.",
    line: "task 3 code.feature → codex (0.82 win rate · $0.31)",
  },
  {
    key: "coordinate",
    title: "Coordinate",
    body: "Agents hold leases on their tasks, ask each other questions through a mailbox, and hand work on as structured packets. You see all of it live.",
    line: "claude-code → codex · handoff · api contract v2",
  },
  {
    key: "verify",
    title: "Verify",
    body: "Results face tests, typecheck, scope checks and a review by a different vendor before a person sees them. Failures go back with the reason.",
    line: "task 3 · tests passed · review by gemini: pass",
  },
  {
    key: "learn",
    title: "Learn",
    body: "Every verdict updates the scoreboard: who wins at which task, at what cost and speed. The next mission routes on it.",
    line: "scoreboard · code.feature · codex ↑ 0.84",
  },
  {
    key: "govern",
    title: "Govern",
    body: "Budgets are checked before dispatch; pushes, deploys and sends wait for an approval; every action lands in an audit ledger.",
    line: "approval needed · open PR #42 · owner",
  },
] as const;

export const CHECKS = [
  { name: "tests", detail: "the project's own tests, in the sandbox" },
  { name: "typecheck", detail: "the compiler, not the agent's word" },
  { name: "diff_scope", detail: "changes stay inside the task's files" },
  { name: "review", detail: "a second vendor reads the diff" },
  { name: "judge", detail: "scores the result against the contract" },
  { name: "injection_scan", detail: "text aimed at the next agent is held for you" },
] as const;

export const AGENT_COUNTS = [
  {
    count: "0",
    title: "No agents yet",
    body: "Brio plans the mission and shows what each task needs, then tells you what to connect.",
  },
  {
    count: "1",
    title: "One agent",
    body: "Everything runs on it. Reviews say plainly they come from the same vendor, and multi-agent modes say they ran single.",
  },
  {
    count: "2+",
    title: "Two or more vendors",
    body: "Brio routes each task to whoever is best at it, has another vendor review the work, and learns from every verdict.",
  },
] as const;

export const SAFETY = [
  {
    title: "Your keys",
    body: "Bring your own vendor keys. They are envelope-encrypted in a vault and never shown again, not even to you.",
  },
  {
    title: "A sandbox per attempt",
    body: "Code runs in its own container with a scoped worktree, no capabilities, CPU, memory and time limits, and a network allowlist.",
  },
  {
    title: "Approvals",
    body: "Irreversible actions (push, deploy, send, purchase, delete) wait for a person, by policy.",
  },
  {
    title: "Budgets",
    body: "Monthly limits per workspace and per agent, checked before every dispatch, not after the bill.",
  },
  {
    title: "A ledger",
    body: "Every agent action is an event. The audit ledger is hash-chained, and owners can verify the chain.",
  },
  {
    title: "Official APIs only",
    body: "No scraping of consumer chat apps and no reuse of anyone's session tokens: official APIs, CLIs, SDKs, MCP and A2A.",
  },
] as const;

export const WAYS_IN = [
  { from: "The web app", how: "Chat, missions, the live board, plans, inbox, scoreboard, budgets" },
  { from: "Your terminal", how: 'brio run "your goal" · brio board' },
  { from: "Claude Code, Cursor, Codex", how: "Brio's MCP server: delegate a goal, get the verified report" },
  { from: "Any A2A agent", how: "Brio is an A2A agent: /.well-known/agent-card.json" },
  { from: "Your own code", how: "The REST API with an API token" },
  { from: "Your own machine", how: "brio runner start: tasks run under your own CLI sign-ins" },
] as const;

export const FEATURES = [
  {
    title: "Chat with all of them",
    body: "Talk to your agents like one assistant: the best one answers, or they answer together, review each other or debate.",
  },
  {
    title: "Live board",
    body: "A lane per agent, task cards, messages between agents, checks and cost against budget, as they happen.",
  },
  {
    title: "Scoreboard",
    body: "Win rate, cost and speed per agent and task type, from real verdicts. Optionally pooled, anonymised, across workspaces.",
  },
  {
    title: "Project memory",
    body: "Decisions and the reasons for them, kept per repository, so the next agent knows why the code is the way it is.",
  },
  {
    title: "Inbox everywhere",
    body: "Plans to approve, questions, results and pull requests reach you in the app, by email, browser push or Slack.",
  },
  {
    title: "Self-host",
    body: "Docker Compose on one machine or Helm on Kubernetes, with the same features. Open source under AGPL-3.0.",
  },
] as const;

export const START = [
  "git clone https://github.com/Ivan825/brio_.git brio && cd brio/deploy/compose",
  "./setup.sh",
  "docker compose up -d",
  "open http://localhost:8080",
] as const;

/** A published doc's page on this site (lib/docs.ts lists them; checked by test). */
export const docPage = (slug: string) => `/docs/${slug}`;

export const LINKS = {
  github: REPO,
  docs: "/docs",
  gettingStarted: docPage("getting-started"),
  selfHost: docPage("self-host"),
  ownerSetup: docPage("owner-setup"),
  deployCloud: docPage("deploy-cloud"),
  architecture: docPage("architecture"),
  security: docPage("security-governance"),
  securityReview: docPage("security-review"),
  routing: docPage("routing-and-quality"),
  handoff: docPage("handoff-packet"),
  connectors: docPage("connectors"),
  adapters: docPage("adapters"),
  adapterSpec: docPage("adapter-spec"),
  api: docPage("api"),
  loadTest: docPage("load-test"),
  changelog: docPage("changelog"),
  decisions: docPage("decisions"),
  prd: docPage("prd"),
  buildPlan: docPage("build-plan"),
  licence: `${REPO}/blob/main/LICENSE`,
  issues: `${REPO}/issues`,
} as const;

/** The board in the hero: what a mission's event stream looks like (brand voice: status lines read like logs). */
export const BOARD = {
  lanes: [
    { agent: "claude-code", task: "t1 · api contract", state: "done" },
    { agent: "codex", task: "t3 · /health endpoint", state: "running" },
    { agent: "gemini", task: "t4 · review t3", state: "waiting" },
  ],
  events: [
    "planner → plan v1 · 4 tasks · est $1.12",
    "you → approved plan v1",
    "claude-code → t1 · contract written · $0.08",
    "claude-code → codex · handoff · api contract v1",
    "codex → t3 · tests passed · $0.31 · 2m14s",
    "gemini → t4 · review t3 · pass",
    "brio → mission done · $0.46 of $5.00",
  ],
} as const;

/** Real screens of the web app (public/shots), captured from a run against Brio's scripted test vendor. */
export const SHOTS = [
  {
    file: "chat",
    title: "Chat",
    caption:
      "Ask anything: two agents answer together and one merges; each one's own answer is a click away.",
  },
  {
    file: "board",
    title: "The live board",
    caption: "One mission: its tasks, attempts, checks, cost and every event, live.",
  },
  {
    file: "plan",
    title: "The plan",
    caption: "Tasks with contracts, the agent each would go to and the estimated cost, before you approve.",
  },
  {
    file: "connectors",
    title: "Connectors",
    caption: "Everything Brio can drive, with your own keys or your own CLI sign-ins.",
  },
  {
    file: "scoreboard",
    title: "Scoreboard",
    caption: "Who wins at which kind of task, at what cost and speed.",
  },
  {
    file: "governance",
    title: "Governance",
    caption: "Budgets, policies, usage and the hash-chained audit ledger.",
  },
] as const;

/** Where things run (the diagram in "Your machines, your data"). */
export const FLOW = [
  { name: "You", items: ["the web app", "brio CLI", "Claude Code, Cursor (MCP)", "any A2A agent"] },
  { name: "Your Brio", items: ["API and orchestrator", "Postgres", "the key vault", "the audit ledger"] },
  { name: "Your runners", items: ["a Docker sandbox per attempt", "or your laptop, under your sign-ins"] },
  { name: "Vendors you chose", items: ["called with your keys", "billed to you directly"] },
] as const;

/** The CLI, as `brio --help` prints it (checked by test). */
export const CLI = [
  ["brio login", "sign in from the terminal (a code you approve in the browser)"],
  ['brio run "<goal>"', "plan a mission; --watch follows it, --quick starts small ones at once"],
  ["brio plan <mission>", "edit a plan: pin agents, gate tasks, reorder"],
  ["brio board <mission>", "the live board in your terminal"],
  ["brio approve", "say yes (or --deny) to what waits for you"],
  ["brio runner register", "make this machine a runner"],
  ["brio runner start", "run your tasks here, under your own CLI sign-ins"],
  ["brio mcp", "Brio's MCP tools over stdio"],
] as const;

/** Where to run it: Brio is self-hosted, so each option is a machine you control (docs/DEPLOY_CLOUD.md). */
export const HOSTING = [
  {
    title: "A cloud server",
    tag: "always on",
    body: "Any Ubuntu server. Free for students: Azure for Students includes a small 1 GB server for 750 hours a month, and Brio's containers measured about 510 MB idle and 560 MB at peak on ready-made images. A free cloudapp.azure.com or duckdns.org name gets real HTTPS on its own.",
    needs: "1 GB RAM + swap · 64 GB disk (ready-made images)",
    alt: "Building the images on the server instead needs 2 CPUs · 4 GB",
    link: "deployCloud",
    cta: "Deploy on a server",
  },
  {
    title: "Your own computer",
    tag: "free",
    body: "Docker Desktop on your Mac or PC. Share it with a free Tailscale Funnel address when others need it.",
    needs: "Docker · 8 GB RAM · 30 GB free",
    alt: null,
    link: "ownerSetup",
    cta: "Set up on your computer",
  },
  {
    title: "Kubernetes",
    tag: "teams",
    body: "A Helm chart: web pods that scale, one worker, runners each with their own Docker engine.",
    needs: "Kubernetes 1.27+ · Postgres with pgvector",
    alt: null,
    link: "selfHost",
    cta: "Install with Helm",
  },
] as const;

/** A fresh Ubuntu server, start to finish (docs/DEPLOY_CLOUD.md). */
export const SERVER_START = [
  "curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER",
  "git clone https://github.com/Ivan825/brio_.git brio && cd brio/deploy/compose",
  "./setup.sh https://ADDRESS --prebuilt",
  "nano .env   # BRIO_SITE_ADDRESS, ports 80/443, BRIO_SIGNUP_ALLOW=you@example.com, BRIO_RUNNER_CONCURRENCY=1",
  "docker compose pull && docker compose up -d --no-build",
] as const;
