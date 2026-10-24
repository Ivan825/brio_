// The docs the site publishes, as data (no file access, so client components may import it too).

export type DocGroup = "Start here" | "Run it" | "Build on it" | "How it works" | "The project";

export const DOC_GROUPS: readonly DocGroup[] = [
  "Start here",
  "Run it",
  "Build on it",
  "How it works",
  "The project",
];

/** Every doc the site publishes, in sidebar order. `file` is relative to docs/. */
export const DOCS = [
  {
    slug: "getting-started",
    file: "GETTING_STARTED.md",
    group: "Start here",
    title: "Getting started",
    summary: "From nothing to a finished mission: a workspace, an agent, a chat and a mission.",
  },
  {
    slug: "owner-setup",
    file: "OWNER_SETUP.md",
    group: "Start here",
    title: "Set up with no domain",
    summary: "Everything on free accounts: your Mac, Gmail email, a public address, Slack, push, MCP.",
  },
  {
    slug: "deploy-cloud",
    file: "DEPLOY_CLOUD.md",
    group: "Run it",
    title: "Deploy on a cloud server",
    summary: "Azure for Students or any Ubuntu server, with free HTTPS and automatic updates.",
  },
  {
    slug: "self-host",
    file: "SELF_HOST.md",
    group: "Run it",
    title: "Self-hosting",
    summary: "Docker Compose or Helm, every setting, backups, upgrades and a smoke test.",
  },
  {
    slug: "load-test",
    file: "LOAD_TEST.md",
    group: "Run it",
    title: "Load test",
    summary: "125 missions at once on one laptop: how it was run and what it measured.",
  },
  {
    slug: "connectors",
    file: "CONNECTORS.md",
    group: "Build on it",
    title: "Connectors",
    summary: "Every agent and model Brio can drive, by category, and how each one connects.",
  },
  {
    slug: "api",
    file: "API.md",
    group: "Build on it",
    title: "API reference",
    summary: "Every REST route, generated from the code.",
  },
  {
    slug: "adapters",
    file: "ADAPTERS.md",
    group: "Build on it",
    title: "Writing an adapter",
    summary: "Add an agent or a model Brio does not know yet.",
  },
  {
    slug: "adapter-spec",
    file: "ADAPTER_SPEC.md",
    group: "Build on it",
    title: "Adapter spec",
    summary: "The AgentAdapter interface and every connector family.",
  },
  {
    slug: "architecture",
    file: "ARCHITECTURE.md",
    group: "How it works",
    title: "Architecture",
    summary: "Services, data model, the mission, task and attempt flows, sandboxes.",
  },
  {
    slug: "routing-and-quality",
    file: "ROUTING_AND_QUALITY.md",
    group: "How it works",
    title: "Planning, routing and verification",
    summary: "The planner, the router, execution modes, the verifier and the scoreboard.",
  },
  {
    slug: "handoff-packet",
    file: "HANDOFF_PACKET.md",
    group: "How it works",
    title: "Handoff packets",
    summary: "The structured context that travels when work moves between agents.",
  },
  {
    slug: "security-governance",
    file: "SECURITY_GOVERNANCE.md",
    group: "How it works",
    title: "Security and governance",
    summary: "Vendor terms, the vault, sandboxes, data routing, budgets, approvals, the ledger.",
  },
  {
    slug: "security-review",
    file: "SECURITY_REVIEW.md",
    group: "The project",
    title: "Security review",
    summary: "The threat model, the method, every finding and what was fixed.",
  },
  {
    slug: "prd",
    file: "PRD.md",
    group: "The project",
    title: "Product requirements",
    summary: "The problem, the users, the requirements and how success is measured.",
  },
  {
    slug: "decisions",
    file: "DECISIONS.md",
    group: "The project",
    title: "Decisions",
    summary: "Every architectural decision, with its reasons and the alternatives.",
  },
  {
    slug: "build-plan",
    file: "BUILD_PLAN.md",
    group: "The project",
    title: "Build plan",
    summary: "Milestones M0–M10, their acceptance criteria and status.",
  },
  {
    slug: "changelog",
    file: "CHANGELOG.md",
    group: "The project",
    title: "Changelog",
    summary: "What each step added, with its evidence.",
  },
] as const satisfies ReadonlyArray<{
  slug: string;
  file: string;
  group: DocGroup;
  title: string;
  summary: string;
}>;

export type DocMeta = (typeof DOCS)[number];

export const docHref = (slug: string) => `/docs/${slug}`;
export const docBySlug = (slug: string) => DOCS.find((d) => d.slug === slug);
