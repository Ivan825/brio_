// What the longer pages say about how Brio works, as data. Names here are the code's own (execution modes, task types,
// check kinds, MCP tools); test/content.test.ts checks each against packages/schema and apps/api.

/** Why Brio exists (docs/PRD.md §2): the four things no other tool combines. */
export const PILLARS = [
  {
    title: "Cross-domain",
    body: "Code, research, writing, data, design, media and browser work. Not only repositories.",
  },
  {
    title: "Verified outcomes",
    body: "Tests, typecheck and a review by another vendor gate every result before you see it.",
  },
  {
    title: "Learned routing",
    body: "A live scoreboard of agent × task type × cost × speed decides who gets each task.",
  },
  {
    title: "Governance built in",
    body: "Budgets, approvals, an audit ledger and your own keys in an encrypted vault.",
  },
] as const;

/** The mission lifecycle (docs/ARCHITECTURE.md §4.1), one line each. */
export const LIFECYCLE = [
  ["You", "give a goal, with a project, files or a GitHub issue, a priority and a budget"],
  ["Planner", "proposes a task graph with contracts and estimates"],
  ["You", "edit and approve the plan (small, cheap plans can start on their own)"],
  ["Router", "picks the agents and the execution mode for each ready task"],
  ["Governance", "checks budgets, data policies and approvals before anything is dispatched"],
  ["Runner", "runs each attempt in a sandbox with a fresh worktree, brief, contract and handoffs"],
  ["Verifier", "runs the contract's checks; failures go back with the reason"],
  ["Scoreboard", "learns from the verdict; leases are released; a handoff packet is written"],
  ["Merge", "integrates verified work in dependency order and reports to you"],
] as const;

/** Task types by group (packages/schema/src/taxonomy.ts). Scores are kept per type. */
export const TASK_GROUPS = [
  {
    group: "Code",
    types: [
      "code.feature",
      "code.bugfix",
      "code.refactor",
      "code.tests",
      "code.review",
      "code.migration",
      "code.frontend_ui",
      "code.infra_devops",
      "code.data_pipeline",
      "code.merge_resolve",
    ],
  },
  {
    group: "Design & contracts",
    types: ["design.api_contract", "design.schema", "design.architecture", "design.ui_mockup"],
  },
  {
    group: "Research",
    types: [
      "research.web",
      "research.deep_report",
      "research.market_chatter",
      "research.academic",
      "research.fact_check",
    ],
  },
  {
    group: "Writing",
    types: ["write.doc", "write.marketing_copy", "write.email", "write.summary", "write.translation_indic"],
  },
  { group: "Data", types: ["data.analysis", "data.extraction", "data.sql"] },
  { group: "Media", types: ["media.image", "media.video", "media.voice", "media.music"] },
  { group: "Browser", types: ["browser.task", "browser.form_fill", "browser.scrape_public"] },
  { group: "Meta", types: ["plan.decompose", "judge.pairwise", "review.rubric", "merge.integrate"] },
] as const;

/** Execution modes (packages/schema), with the default rule that picks each (docs/ROUTING_AND_QUALITY.md §3.2). */
export const MODES = [
  {
    mode: "single",
    title: "Single",
    what: "One agent does the task; a rubric review from another vendor checks it.",
    when: "Writing and media by default",
  },
  {
    mode: "best_of_n",
    title: "Best of n",
    what: "Two or three agents from different vendors try; the tests decide, a judge breaks ties.",
    when: "Code with tests, when the budget allows",
  },
  {
    mode: "maker_checker",
    title: "Maker–checker",
    what: "One vendor makes, another reviews and sends it back until it passes.",
    when: "Code without tests",
  },
  {
    mode: "ensemble",
    title: "Ensemble",
    what: "Several agents answer; a merger dedupes and reconciles them, keeping citations.",
    when: "Deep research reports",
  },
  {
    mode: "debate",
    title: "Debate",
    what: "Two vendors propose and argue; a judge picks and merges.",
    when: "Design, planning and high-stakes contracts",
  },
  {
    mode: "cascade",
    title: "Cascade",
    what: "A cheap model first; it escalates to a stronger one only when a check fails.",
    when: "Summaries, extraction and other utility work",
  },
  {
    mode: "pipeline",
    title: "Pipeline",
    what: "A fixed sequence of agents you saved as a template.",
    when: "Your own templates",
  },
] as const;

/** Chat's modes and the execution mode each one runs (D-109). */
export const CHAT_MODES = [
  {
    key: "auto",
    title: "Auto",
    mode: "single",
    body: "The agent best at that kind of question answers, chosen by the scoreboard.",
    needs: "1 agent",
  },
  {
    key: "together",
    title: "Together",
    mode: "ensemble",
    body: "Each agent you picked answers, then one merges them into a single reply.",
    needs: "2+ agents",
  },
  {
    key: "review",
    title: "Review",
    mode: "maker_checker",
    body: "One answers; another checks it and asks for fixes until it holds up.",
    needs: "2+ agents",
  },
  {
    key: "debate",
    title: "Debate",
    mode: "debate",
    body: "They argue it out, and a judge decides and writes the answer.",
    needs: "2+ agents",
  },
] as const;

/** Acceptance check kinds (packages/schema/src/contract.ts) and how each is run. */
export const CHECK_KINDS = [
  ["tests", "the project's own tests, in the sandbox; pass is exit 0, counts are parsed"],
  ["typecheck", "the compiler, not the agent's word"],
  ["lint", "the project's linter"],
  ["build", "the build has to succeed"],
  ["contract_conformance", "the output matches the contract: OpenAPI diff, TypeScript types, JSON Schema"],
  ["diff_scope", "changed files stay inside the task's leased footprint"],
  ["rubric_review", "a model from a different vendor scores it against the objective, 1–5 per criterion"],
  ["fact_check", "claims are pulled out and checked against the cited sources"],
  ["citation_present", "every factual paragraph has a source"],
  ["media_spec", "dimensions, duration and format; optionally a vision check against the brief"],
  ["link_check", "every link in a web output resolves"],
  ["a11y", "accessibility checks on web outputs"],
  ["lighthouse", "performance and best-practice scores on web outputs"],
  ["human", "a person approves"],
] as const;

/** Brio's MCP server tools (apps/api/src/mcp/server.ts). */
export const MCP_TOOLS = [
  ["delegate", "hand Brio a goal; get the verified report back"],
  ["plan_mission", "plan a goal without running it"],
  ["approve_plan", "start a plan you have read"],
  ["mission_status", "a mission's status, its tasks and the questions waiting for you"],
  ["list_missions", "the workspace's recent missions"],
  ["pending_approvals", "what waits for a person"],
  ["decide_approval", "approve or deny (needs the brio:approve scope)"],
  ["ask_agent", "ask the agent working on a task a question, and wait for its answer"],
  ["answer", "answer a question an agent asked you"],
  ["get_brief", "a mission's brief, and what the project remembers about some paths or a topic"],
  ["get_contract", "read a mission's interface contract, by name"],
  ["request_review", "ask a person to review something; it lands in their inbox"],
  ["report", "a mission's report: who did what, the evidence, the cost, what is open"],
] as const;

/** The task state machine (docs/ARCHITECTURE.md §4.2). */
export const TASK_STATES = ["pending", "ready", "leased", "running", "verifying", "done"] as const;

export const FAQ = [
  {
    q: "Is Brio another AI agent?",
    a: "No. Brio is the conductor: it plans, routes, coordinates, checks and governs the agents you already use. It has no model of its own, and it works with any of the connectors in its registry, plus any A2A agent.",
  },
  {
    q: "Do I need several paid subscriptions?",
    a: "No. One agent is enough to start: Brio plans, runs and checks everything with it, and says honestly when a review came from the same vendor. Free API tiers (Gemini, Groq and others) and local models work too. A second vendor unlocks cross-vendor review and the multi-agent chat modes.",
  },
  {
    q: "Can I use my ChatGPT or Claude subscription?",
    a: "Not through their chat apps: Brio never automates consumer chat sites or reuses their sign-in tokens. On your own machine, the local runner can run a vendor's official CLI under your own sign-in where the vendor's terms allow it (Antigravity; Claude Code for your own work).",
  },
  {
    q: "Who sees my code and my keys?",
    a: "You and the vendors you connect. Brio is self-hosted: there is no Brio cloud and no account with us. Keys are envelope-encrypted in your vault, decrypted only for an attempt, and redacted from every log and event.",
  },
  {
    q: "What does it cost?",
    a: "Brio is free and open source under AGPL-3.0. You pay the vendors directly for what your agents use, with your own keys, and Brio checks a budget before every dispatch. A server can be free too: Azure for Students includes a small one.",
  },
  {
    q: "What if an agent's work is wrong?",
    a: "It goes back. Each task's contract names its checks; a failed hard check sends the work back with the reason (up to twice), then to the next-best agent, then to a re-plan. Nothing reaches you without its evidence.",
  },
  {
    q: "Is it only for code?",
    a: "No. Tasks cover code, design and contracts, research, writing, data, media and browser work, each with its own checks. A mission can mix them: a feature, its docs, a hero image and a launch email.",
  },
  {
    q: "Can I keep using Claude Code or Cursor?",
    a: "Yes. Add Brio's MCP server to them and they can delegate a goal to Brio and get the verified report back, or ask for a review from another vendor.",
  },
  {
    q: "What happens to my repository?",
    a: "Every attempt works in its own git worktree on its own branch. Verified work is merged into an integration branch, and pushing it or opening a pull request waits for your approval.",
  },
  {
    q: "How do I run it?",
    a: "Docker Compose on any machine: your laptop, a small cloud server with ready-made images, or Kubernetes with the Helm chart. The guides take about fifteen minutes and need no domain.",
  },
] as const;
