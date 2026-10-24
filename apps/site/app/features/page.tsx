import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { Cards, Cta, OnThisPage, PageHero, Table, Ticks, textLink } from "@/components/blocks";
import { ChatModes } from "@/components/diagrams";
import { Section } from "@/components/section";
import { CLI, CONNECTOR_COUNT, LINKS, SHOTS } from "@/lib/content";
import { MCP_TOOLS, MODES } from "@/lib/product";
import { byCategory } from "@/lib/registry";

export const metadata: Metadata = {
  title: "Features",
  description:
    "Chat, missions, the live board, the scoreboard, crews, memory, governance, connectors, the CLI, MCP, A2A and the local runner.",
};

const SECTIONS = [
  { id: "chat", label: "Chat" },
  { id: "missions", label: "Missions and plans" },
  { id: "board", label: "Live board" },
  { id: "inbox", label: "Inbox" },
  { id: "scoreboard", label: "Scoreboard" },
  { id: "crews", label: "Crews and templates" },
  { id: "memory", label: "Project memory" },
  { id: "governance", label: "Governance" },
  { id: "connectors", label: "Connectors" },
  { id: "ways-in", label: "CLI, MCP, A2A, API" },
  { id: "local-runner", label: "Local runner" },
  { id: "teams", label: "Teams" },
  { id: "operate", label: "Run it" },
] as const;

/** A real screen of the app with its caption. */
function Shot({ file }: { file: string }) {
  const s = SHOTS.find((x) => x.file === file);
  return (
    <figure>
      <a
        href={`/shots/${file}.jpg`}
        className="block overflow-hidden rounded-lg border border-line bg-surface transition-colors duration-fast hover:border-line-strong"
      >
        <Image
          src={`/shots/${file}.jpg`}
          alt={s ? `${s.title}: ${s.caption}` : file}
          width={1440}
          height={900}
          className="block h-auto w-full"
        />
      </a>
      {s ? <figcaption className="mt-2 text-sm text-fg-muted">{s.caption}</figcaption> : null}
    </figure>
  );
}

/** Text on one side, a screen on the other. */
function Split({ shot, children }: { shot: string; children: ReactNode }) {
  return (
    <div className="grid items-start gap-8 lg:grid-cols-[1fr_1.25fr]">
      <div>{children}</div>
      <Shot file={shot} />
    </div>
  );
}

export default function Features() {
  const categories = byCategory();
  return (
    <>
      <PageHero
        label="features"
        title="Everything you need to run many agents as one."
        lead="Brio is a complete product, not a wrapper: a web app, a CLI, an MCP and A2A server, sandboxed runners, a scoreboard, governance and self-hosting, all built and tested. Here is every part of it."
      >
        <OnThisPage items={SECTIONS} />
      </PageHero>

      <Section
        id="chat"
        index="01"
        label="Chat"
        title="Talk to all your agents like one assistant."
        lead="Ask anything. The best agent for it answers, or several build the reply between them."
      >
        <Split shot="chat">
          <Ticks
            items={[
              "pick who takes part above the message box; agents that can't run yet say why",
              "follow-ups carry the conversation; replies arrive live",
              "see each agent's own answer, the cost and the checks behind every reply",
              "copy, stop a reply mid-way, or rate it to teach the scoreboard",
              "turn any reply into a full mission, with the chat as context",
              "answers render as Markdown; raw HTML from agents is shown as text",
            ]}
          />
        </Split>
        <div className="mt-10">
          <ChatModes />
        </div>
      </Section>

      <Section
        id="missions"
        index="02"
        label="Missions and plans"
        title="Give a goal; edit the plan before it runs."
        lead="Start from a sentence, files, a GitHub issue or pull request, and a project. Choose a priority and a budget, or leave them."
      >
        <Split shot="plan">
          <Ticks
            items={[
              "a plan of typed tasks, each with a contract and checks",
              "edit it as a list or a graph: reorder, split, merge, gate, pin an agent",
              "every edit makes a new plan version; approve the one you want",
              "estimated cost per task and in total, before you spend anything",
              "quick start for small, cheap plans (no questions, ≤ $5, ≤ 10 tasks)",
              "up to three blocking questions, each with a default",
            ]}
          />
        </Split>
        <div className="mt-10">
          <Table caption="Execution modes, per task" rows={MODES.map((m) => [m.mode, m.what])} minWidth={0} />
        </div>
      </Section>

      <Section
        id="board"
        index="03"
        label="Live board"
        title="Watch every agent work, as it happens."
        lead="A lane per agent in its own colour, task cards with ids, a brass line for running work and verdict chips: pass, revise, fail."
      >
        <Split shot="board">
          <Ticks
            items={[
              "attempts, messages between agents and handoffs, live",
              "checks passing or sending work back, with their output",
              "cost against the budget, per task and in total",
              "a reconnect resumes exactly where it left off",
              "the same board in your terminal: brio board",
              "the report at the end: what was done, by whom, what is open",
            ]}
          />
        </Split>
      </Section>

      <Section
        id="inbox"
        index="04"
        label="Inbox and notifications"
        title="What needs you finds you."
        lead="Plans to approve, questions from agents, results to review and pull requests to open land in one inbox, and reach you where you are."
      >
        <Cards
          cols={4}
          items={[
            { title: "In the app", body: "One inbox per workspace, with the decision buttons right there." },
            { title: "Email", body: "Through Resend or any SMTP mailbox, Gmail included. No domain needed." },
            { title: "Browser push", body: "Web push signed with your deployment's own VAPID keys." },
            {
              title: "Slack",
              body: "Your workspace's own Slack app, with Approve and Deny buttons verified by signature.",
            },
          ]}
        />
        <p className="mt-6 text-sm text-fg-muted">
          Each person chooses what reaches them on each channel, and each event notifies each person once per
          channel.
        </p>
      </Section>

      <Section
        id="scoreboard"
        index="05"
        label="Scoreboard"
        title="Who wins at what, measured on your work."
        lead="Pass rate, head-to-head strength, cost and speed per agent and task type, from real verdicts. Brio routes by it, and you can read it."
      >
        <Split shot="scoreboard">
          <Ticks
            items={[
              "one row per connector and model pair, per task type",
              "the router's rationale for every pick, in plain words",
              "your ratings count, and new models can climb",
              "optional pooled priors across workspaces, opt-in both ways",
              "a golden-mission eval harness compares Brio with each agent alone",
            ]}
          />
          <p className="mt-6 text-sm text-fg-muted">
            <Link href="/how-it-works#learn" className={textLink}>
              How the scores are kept
            </Link>
          </p>
        </Split>
      </Section>

      <Section
        id="crews"
        index="06"
        label="Crews and templates"
        title="Save the teams and the missions you run often."
        lead="A crew is a saved set of agents with an agent per task type; a template is a plan saved as a pipeline."
      >
        <Cards
          cols={2}
          items={[
            {
              title: "Crews",
              body: "A mission routed to a crew uses only its agents, reviews included, and the crew's pins unless the plan pins another. A deleted crew leaves the mission with no agents rather than quietly using everyone.",
            },
            {
              title: "Templates",
              body: "Start a mission from a template adapted to the new goal (the planner keeps its shape) or exactly as saved.",
            },
          ]}
        />
      </Section>

      <Section
        id="memory"
        index="07"
        label="Project memory"
        title="The next agent knows why the code is the way it is."
        lead="Each project keeps a memory graph, built from events: missions, tasks, contracts, prompts, decisions and the files they touched."
      >
        <Cards
          items={[
            {
              title: "Briefs",
              body: "Every attempt on a project gets a brief for the paths or topic it works on, in .brio/brief.md.",
            },
            {
              title: "Yours to correct",
              body: "People add, correct and forget items; each change is in the ledger.",
            },
            {
              title: "One database",
              body: "Postgres with pgvector: no extra service to run or secure.",
            },
          ]}
        />
      </Section>

      <Section
        id="governance"
        index="08"
        label="Governance"
        title="Spend, policy and audit, built in."
        lead="Budgets are checked before dispatch, policies decide where work may go, and every action lands in a hash-chained ledger."
      >
        <Split shot="governance">
          <Ticks
            items={[
              "monthly budgets per workspace and per agent; a mission's and a task's own",
              "a live guard warns, then stops an attempt within seconds of crossing a limit",
              "data-routing, connector, network and approval policies",
              "usage by day, agent, vendor and task type",
              "a ledger you can verify and export as JSONL or CSV",
              "optionally, spending authority from your own Mandate",
            ]}
          />
          <p className="mt-6 text-sm text-fg-muted">
            <Link href="/security" className={textLink}>
              The security model
            </Link>
          </p>
        </Split>
      </Section>

      <Section
        id="connectors"
        index="09"
        label="Connectors"
        title={`${CONNECTOR_COUNT} connectors, one interface.`}
        lead="Everything Brio drives goes through one AgentAdapter interface, recorded as data in a registry. Model lists come live from each vendor."
      >
        <Split shot="connectors">
          <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {categories.map((c) => (
              <li
                key={c.key}
                className="flex items-baseline justify-between gap-3 border-b border-line py-1.5"
              >
                <Link href={`${LINKS.connectors}#${c.slug}`} className="text-sm text-fg-muted hover:text-fg">
                  {c.label}
                </Link>
                <span className="font-mono text-xs text-accent">{c.names.length}</span>
              </li>
            ))}
          </ul>
          <p className="mt-6 text-sm text-fg-muted">
            Missing one?{" "}
            <Link href={LINKS.adapters} className={textLink}>
              Write an adapter
            </Link>
            ; the test kit checks it against the spec.
          </p>
        </Split>
      </Section>

      <Section
        id="ways-in"
        index="10"
        label="CLI, MCP, A2A, API"
        title="Use Brio from wherever you already work."
        lead="The web app is one door. The others: your terminal, your editor's agent over MCP, any A2A agent, and the REST API."
      >
        <div className="grid items-start gap-8 lg:grid-cols-2">
          <Table caption="The brio CLI" rows={CLI.map(([c, w]) => [c, w])} minWidth={0} />
          <Table caption="Brio's MCP tools" rows={MCP_TOOLS.map(([t, w]) => [t, w])} minWidth={0} />
        </div>
        <div className="mt-8">
          <Cards
            items={[
              {
                title: "MCP server",
                body: "Claude Code, Cursor, Codex and other MCP clients sign in with OAuth 2.1 and delegate goals. Approving needs a scope a person grants on the consent page.",
              },
              {
                title: "A2A agent",
                body: "Brio publishes its agent card at /.well-known/agent-card.json; incoming A2A tasks become missions in the caller's workspace.",
              },
              {
                title: "REST API",
                body: "Every route, generated from the code, with API tokens from Settings and a TypeScript SDK.",
                meta: <Link href={LINKS.api}>API reference →</Link>,
              },
            ]}
          />
        </div>
      </Section>

      <Section
        id="local-runner"
        index="11"
        label="Local runner"
        title="Run tasks on your own machine, under your own sign-ins."
        lead="brio runner start connects your laptop to Brio, outbound only. Projects that live on it run there, with the coding CLIs you are already signed in to, where the vendor's terms allow it."
      >
        <Cards
          cols={2}
          items={[
            {
              title: "Docker mode, by default",
              body: "The same sandbox as the cloud runner: a container, a fresh worktree, limits and an allowlist.",
            },
            {
              title: "Host mode, with consent",
              body: "No container: a fresh worktree, a cut-down environment and the attempt's time limit. Only after you agree to those exact terms, recorded with the time.",
            },
            {
              title: "Your work only",
              body: "Work reaches your runner only for missions you created, from a plan you approved. Vault keys never go to it.",
            },
            {
              title: "Sign-ins stay put",
              body: "The runner launches the official CLI as documented and never reads what it stores.",
            },
          ]}
        />
      </Section>

      <Section
        id="teams"
        index="12"
        label="Teams"
        title="Workspaces, roles and invitations."
        lead="Everything belongs to a workspace: agents, missions, budgets, the ledger. Invite people by email; sign in with an emailed link, Google or a passkey."
      >
        <Table
          head={["", "owner", "admin", "member", "viewer"]}
          rows={[
            ["read missions, boards, scores, memory", "✓", "✓", "✓", "✓"],
            ["start missions, edit plans, run agents, approve", "✓", "✓", "✓", ""],
            ["connectors, budgets, policies, ledger, Slack", "✓", "✓", "", ""],
            ["invite; move people between member and viewer", "✓", "✓", "", ""],
            ["make owners and admins; delete the workspace", "✓", "", "", ""],
          ]}
          mono={false}
          minWidth={600}
        />
      </Section>

      <Section
        id="operate"
        index="13"
        label="Run it"
        title="Self-hosted, with everything an operator needs."
        lead="Docker Compose on one machine or a Helm chart on Kubernetes, with the same features. Open source under AGPL-3.0."
      >
        <Cards
          items={[
            {
              title: "Fifteen-minute install",
              body: "A setup script writes fresh secrets; Caddy gets an HTTPS certificate on its own. No domain needed.",
            },
            {
              title: "Automatic updates",
              body: "A systemd timer follows the main branch and restarts Brio on new versions; your settings are never changed.",
            },
            {
              title: "Ready-made images",
              body: "A small server downloads images instead of building them, so 1 GB of memory is enough.",
            },
            {
              title: "Backups and a smoke test",
              body: "One command dumps the database; another proves an install works end to end.",
            },
            {
              title: "A status page",
              body: "Each part's health, public, with nothing about any workspace.",
            },
            {
              title: "A billing hook",
              body: "For operators hosting Brio for others: each workspace's day, signed and sent once.",
            },
          ]}
        />
      </Section>

      <Cta
        title="All of it is in the box."
        lead="No paid tier and no feature held back: clone it, run it, and connect the agents you already have."
      />
    </>
  );
}
