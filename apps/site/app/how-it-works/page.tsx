import type { Metadata } from "next";
import Link from "next/link";
import {
  Cards,
  Code,
  Cta,
  OnThisPage,
  PageHero,
  secondary,
  Table,
  Ticks,
  textLink,
} from "@/components/blocks";
import { Board } from "@/components/board";
import { Layers, PlanGraph, RouterBars, Sandbox, StateMachine } from "@/components/diagrams";
import { Section } from "@/components/section";
import { LINKS } from "@/lib/content";
import { CHAT_MODES, CHECK_KINDS, LIFECYCLE, MODES, TASK_GROUPS } from "@/lib/product";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "From one goal to a verified result: how Brio plans, routes, coordinates, runs, verifies, learns and governs.",
};

const SECTIONS = [
  { id: "lifecycle", label: "A mission, start to end" },
  { id: "plan", label: "Plan" },
  { id: "route", label: "Route" },
  { id: "modes", label: "Execution modes" },
  { id: "coordinate", label: "Coordinate" },
  { id: "run", label: "Run" },
  { id: "verify", label: "Verify" },
  { id: "learn", label: "Learn" },
  { id: "deliver", label: "Merge and deliver" },
  { id: "events", label: "Events" },
  { id: "chat", label: "Chat, underneath" },
] as const;

const CONTRACT = `{
  objective: "GET /health returns 200 and the build's version",
  inputs:   [{ kind: "contract", ref: "health-api@v1" }],
  outputs:  [{ kind: "diff", description: "the route and its test" }],
  acceptance: [
    { kind: "tests",       hard: true, command: "pnpm test -- health" },
    { kind: "typecheck",   hard: true },
    { kind: "diff_scope",  hard: true },
    { kind: "rubric_review", hard: false, criteria: ["matches the contract"] }
  ],
  constraints: ["no new dependencies"],
  expectedFootprint: { paths: ["apps/api/src/routes/health.ts", "apps/api/test/**"] },
  sensitivity: "internal",
  budget: { usd: 0.8, minutes: 20 }
}`;

const PACKET = `{
  "from": { "taskKey": "t1", "agentKey": "claude-code", "vendor": "anthropic" },
  "to":   { "taskKey": "t2" },
  "objective": "Implement GET /health against contract health-api@v1",
  "done": ["Wrote the contract: status, version, uptime"],
  "decisions": [{ "id": "d1", "statement": "Version comes from package.json, not git" }],
  "openQuestions": [{ "question": "Expose uptime publicly?", "defaultIfUnanswered": "yes", "askWho": "user" }],
  "contracts": [{ "name": "health-api", "version": "1", "ref": ".brio/contract.json" }],
  "evidence": [{ "kind": "review", "ref": "review/42", "summary": "gemini: pass" }],
  "risks": ["Load balancers may cache /health"],
  "nextSteps": ["Add the route", "Test 200 and the version field"],
  "trust": "untrusted-content"
}`;

export default function HowItWorks() {
  return (
    <>
      <PageHero
        label="how it works"
        title="From one goal to a verified result."
        lead="Brio is a loop with six steps (plan, route, coordinate, verify, learn, govern), and every step is an event you can watch, replay and audit. This page walks through each one with the real names the code uses."
      >
        <OnThisPage items={SECTIONS} />
      </PageHero>

      <Section
        id="lifecycle"
        index="01"
        label="A mission, start to end"
        title="Nine hand-offs between you, the brain and the runners."
        lead="The brain decides, runners execute, governance can veto anything, and events record everything. Postgres is the only infrastructure: the data, the queue and the run state all live there."
      >
        <div className="grid gap-8 lg:grid-cols-[1fr_1.1fr]">
          <ol className="space-y-px overflow-hidden rounded-lg border border-line bg-line">
            {LIFECYCLE.map(([who, what], i) => (
              <li key={`${who}-${what}`} className="flex gap-4 bg-bg px-4 py-3">
                <span className="w-5 shrink-0 font-mono text-xs text-fg-subtle">{i + 1}</span>
                <span className="w-24 shrink-0 font-mono text-xs text-accent">{who}</span>
                <span className="text-sm text-fg-muted">{what}</span>
              </li>
            ))}
          </ol>
          <Layers />
        </div>
      </Section>

      <Section
        id="plan"
        index="02"
        label="Plan"
        title="A goal becomes a graph of tasks, each with a contract."
        lead="The planner is itself a task (plan.decompose) given to the agent that scores best at planning. Its output is validated against a schema and retried with the errors until it is right."
      >
        <PlanGraph />
        <div className="mt-10 grid gap-8 lg:grid-cols-2">
          <div>
            <h3 className="font-mono text-md font-bold text-fg">Five passes over every plan</h3>
            <ol className="mt-4 space-y-3">
              {[
                [
                  "Decompose",
                  "tasks with a type, a contract, dependencies, a suggested mode and an estimate",
                ],
                [
                  "Contracts first",
                  "shared interfaces (an API between front and back end, a schema, file formats) become their own design tasks that every dependant waits for",
                ],
                [
                  "Leases",
                  "each code task's footprint (paths, symbols) is predicted; two parallel tasks that overlap get a dependency or a split",
                ],
                [
                  "Estimate",
                  "cost and time per task, from the scoreboard's averages for that type and agent",
                ],
                [
                  "Lint",
                  "no cycles, every task has acceptance checks, every leaf serves the goal, the budget fits",
                ],
              ].map(([t, b], i) => (
                <li key={t} className="flex gap-3 text-sm">
                  <span className="font-mono text-fg-subtle">{i + 1}</span>
                  <span>
                    <span className="font-medium text-fg">{t}:</span>{" "}
                    <span className="text-fg-muted">{b}</span>
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-6 text-sm text-fg-muted">
              You see the plan before anything runs: its tasks, contracts, the agent each would go to and the
              estimated cost. Reorder, split, merge, pin an agent, add a check, then approve. At most three
              questions come back with it, and only ones that block the work. Small, cheap plans can start on
              their own.
            </p>
          </div>
          <Code label="TaskContract · packages/schema">{CONTRACT}</Code>
        </div>
        <div className="mt-10">
          <h3 className="font-mono text-md font-bold text-fg">
            {TASK_GROUPS.flatMap((g) => g.types).length} task types, fixed and versioned
          </h3>
          <p className="mt-2 max-w-2xl text-sm text-fg-muted">
            Every task gets exactly one type, and scores are kept per type, so the list changes only with a
            migration.
          </p>
          <div className="mt-5">
            <Table
              rows={TASK_GROUPS.map((g) => [
                g.group,
                <span key="t" className="flex flex-wrap gap-1.5">
                  {g.types.map((t) => (
                    <code
                      key={t}
                      className="rounded-xs border border-line bg-surface px-1.5 py-0.5 font-mono text-2xs text-fg-muted"
                    >
                      {t}
                    </code>
                  ))}
                </span>,
              ])}
              mono={false}
              minWidth={0}
            />
          </div>
        </div>
      </Section>

      <Section
        id="route"
        index="03"
        label="Route"
        title="Each task goes to the agent most likely to win it."
        lead="Candidates are filtered first, then scored. A pin always wins: you can send any task to any agent yourself."
      >
        <div className="grid gap-8 lg:grid-cols-2">
          <div className="min-w-0 space-y-6">
            <div>
              <h3 className="font-mono text-sm font-bold text-fg">1 · Filter</h3>
              <p className="mt-2 text-sm text-fg-muted">
                Only agents that can do the task&apos;s type, that the data policy allows for its sensitivity,
                that are healthy, have a known price and fit the budget. A confidential task with no policy
                goes only to local models.
              </p>
            </div>
            <div>
              <h3 className="font-mono text-sm font-bold text-fg">2 · Score</h3>
              <p className="mt-2 text-sm text-fg-muted">
                Thompson sampling with a cost-aware utility: draw a pass rate from each agent&apos;s Beta
                posterior, add its head-to-head strength, subtract its normalised cost and latency.
              </p>
              <pre className="mt-3 overflow-x-auto rounded-md border border-line bg-surface p-3 font-mono text-2xs text-fg">
                {`sample q ~ Beta(α, β)
utility = q + λ_elo·elo − λ_cost·cost − λ_time·latency`}
              </pre>
            </div>
            <div>
              <h3 className="font-mono text-sm font-bold text-fg">3 · Explain</h3>
              <p className="mt-2 text-sm text-fg-muted">
                Every decision is logged with its rationale, the mode and the estimate, so you can see why an
                agent was picked and overrule it next time.
              </p>
            </div>
          </div>
          <div className="min-w-0 space-y-6">
            <RouterBars />
            <Table
              caption="The mission's priority sets the weights"
              head={["priority", "what it favours"]}
              rows={[
                ["quality", "the best pass rate; cost barely counts (λ_cost 0.05)"],
                ["balanced", "the default: quality, with cost in view (λ_cost 0.2)"],
                ["cheap", "the lowest cost that still passes (λ_cost 0.5)"],
                ["fast", "the shortest time to a verified result (λ_time 0.5)"],
              ]}
              minWidth={0}
            />
          </div>
        </div>
      </Section>

      <Section
        id="modes"
        index="04"
        label="Execution modes"
        title="Seven ways to put agents on one task."
        lead="Default rules choose a mode per task; the planner or you can override it. In every multi-agent mode Brio prefers agents from different vendors, because their errors correlate less."
      >
        <Table
          head={["mode", "how it works", "chosen by default for"]}
          rows={MODES.map((m) => [
            m.mode,
            m.what,
            <span key="w" className="text-fg-subtle">
              {m.when}
            </span>,
          ])}
          minWidth={680}
        />
        <p className="mt-6 text-sm text-fg-muted">
          With fewer agents than a mode needs, it runs with what there is and says so on the board: a
          best-of-two with one agent runs once, and a review by the same vendor is labelled as one.
        </p>
      </Section>

      <Section
        id="coordinate"
        index="05"
        label="Coordinate"
        title="Agents in parallel, without trampling each other."
        lead="Four mechanisms keep parallel work coherent: leases on what each task may touch, versioned contracts, a mailbox between running agents, and handoff packets when work moves on."
      >
        <Cards
          cols={2}
          items={[
            {
              title: "Leases",
              body: "A task holds a lease on its footprint while it runs, renewed by a heartbeat every 30 s and released after 2 minutes without one. Overlapping work waits, blocked, or the planner splits it. Writes outside the footprint are refused for CLI agents and flagged by diff_scope for all.",
            },
            {
              title: "Contracts",
              body: "Dependants get the contract as .brio/contract.json. Changing a published contract bumps its version, emits contract.changed, and sends dependants that are not yet verified back to revise.",
            },
            {
              title: "The mailbox",
              body: "A running agent can ask another a question (ask_agent), report a blocker or read a contract through Brio's MCP tools. Unanswered after five minutes, the planner answers from memory and the contracts, or asks you.",
            },
            {
              title: "Project memory",
              body: "A graph of missions, tasks, contracts, decisions and files, built from events. Every attempt gets a brief for the paths it touches, so the next agent knows why the code is the way it is.",
            },
          ]}
        />
        <div className="mt-10 grid gap-8 lg:grid-cols-[1fr_1.2fr]">
          <div>
            <h3 className="font-mono text-md font-bold text-fg">Handoff packets</h3>
            <p className="mt-2 text-sm text-fg-muted">
              When a task passes, Brio writes a packet for the tasks that depend on it: what was done, what
              was decided and must not be reopened, open questions with defaults, contracts, evidence, risks
              and next steps. Deterministic fields come from the database, not a model.
            </p>
            <div className="mt-4">
              <Ticks
                items={[
                  "rendered into the receiver's prompt as quoted, untrusted context",
                  "written to .brio/handoff.json in its worktree",
                  "never carries a secret; checked like any other output",
                ]}
              />
            </div>
            <Link href={LINKS.handoff} className={`mt-5 inline-block text-sm ${textLink}`}>
              The packet format →
            </Link>
          </div>
          <Code label="HandoffPacket · .brio/handoff.json (abridged)">{PACKET}</Code>
        </div>
      </Section>

      <Section
        id="run"
        index="06"
        label="Run"
        title="One sandbox and one git worktree per attempt."
        lead="An attempt is one agent's run at one task. Runners pull attempts from a queue in Postgres and run each in its own container, on its own branch, with its own limits."
      >
        <Sandbox />
        <div className="mt-10 grid items-start gap-8 lg:grid-cols-2">
          <ol className="space-y-px overflow-hidden rounded-lg border border-line bg-line">
            {[
              "fetch the attempt, its agent and the key, decrypted in memory only",
              "create the sandbox from its profile: image, CPU, memory, network allowlist, timeout",
              "check the project out into a fresh worktree on brio/<mission>/<task>/<attempt>",
              "write the brief, the contract and incoming handoffs into .brio/",
              "give CLI agents Brio's MCP mailbox",
              "run the adapter; turn what it does into events",
              "enforce the limits on tokens, cost and time; kill on a breach",
              "collect the diff, new files and outputs, with their sha256",
              "tear the sandbox down; keep the branch for the merge",
            ].map((s, i) => (
              <li key={s} className="flex gap-4 bg-bg px-4 py-2.5 text-sm text-fg-muted">
                <span className="w-5 shrink-0 font-mono text-xs text-fg-subtle">{i + 1}</span>
                {s}
              </li>
            ))}
          </ol>
          <Table
            caption="Sandbox profiles"
            head={["profile", "for", "limits"]}
            rows={[
              ["code-standard", "coding CLIs", "2 vCPU · 4 GB · 45 min"],
              ["code-heavy", "builds, end-to-end tests", "4 vCPU · 8 GB · 90 min"],
              ["api-only", "model API calls", "0.5 vCPU · 512 MB · 15 min"],
              ["browser", "browser agents", "2 vCPU · 4 GB · 30 min"],
              ["media", "media APIs", "0.5 vCPU · 1 GB · 30 min"],
            ]}
            minWidth={0}
          />
        </div>
        <p className="mt-6 text-sm text-fg-muted">
          Every vendor is reached through one interface,{" "}
          <code className="font-mono text-fg">AgentAdapter</code>: model APIs, coding CLIs run headless as
          documented, hosted agent APIs, A2A agents, MCP tools, browser and media models.{" "}
          <Link href={LINKS.adapterSpec} className={textLink}>
            The adapter spec
          </Link>
          .
        </p>
      </Section>

      <Section
        id="verify"
        index="07"
        label="Verify"
        title="Checks decide, not the agent's word."
        lead="After every attempt the verifier runs the contract's checks. Hard checks gate the verdict; soft ones inform it. Every result also gets a hard injection scan, so text aimed at the next agent reaches a person first."
      >
        <Table head={["check", "how it runs"]} rows={CHECK_KINDS.map(([k, how]) => [k, how])} minWidth={0} />
        <div className="mt-10">
          <StateMachine />
        </div>
        <div className="mt-8">
          <Cards
            items={[
              {
                title: "pass",
                body: "All hard checks pass and the rubric clears its threshold. Leases are released and a handoff is written.",
              },
              {
                title: "revise",
                body: "A hard check failed: the failures go back to the same agent, up to twice. Then the task is rerouted to the next-best agent.",
              },
              {
                title: "fail",
                body: "Still failing after a reroute: Brio proposes a new plan rather than handing you broken work.",
              },
            ]}
          />
        </div>
        <p className="mt-6 text-sm text-fg-muted">
          Judges compare candidates pairwise in both orders to cancel position bias; tests outrank a
          judge&apos;s opinion, and the judge is from another vendor wherever possible.
        </p>
      </Section>

      <Section
        id="learn"
        index="08"
        label="Learn"
        title="A scoreboard you own, from real verdicts."
        lead="Every verdict updates the scores of that agent at that task type. Each connector and model pair is scored on its own."
      >
        <Cards
          cols={4}
          items={[
            {
              title: "Pass rate",
              body: "A Beta(α, β) posterior: a pass adds to α, a fail to β, a revise counts half.",
            },
            { title: "Strength", body: "Elo per task type, from best-of-n and debate judgements." },
            { title: "Cost", body: "A moving average of dollars per attempt." },
            { title: "Speed", body: "A moving average of time to a result." },
          ]}
        />
        <div className="mt-8 grid gap-6 md:grid-cols-3">
          {[
            [
              "Your ratings count",
              "Thumbs up adds half a pass; thumbs down, a fail. Rate chat replies and mission results alike.",
            ],
            [
              "New models can climb",
              "Scores decay with a 60-day half-life, and a new model starts from its predecessor's record at low weight.",
            ],
            [
              "Global priors, opt-in",
              "Workspaces may pool anonymised outcomes. They are used only with 20 outcomes from 3 workspaces, and your own scores always come first.",
            ],
          ].map(([t, b]) => (
            <div key={t} className="rounded-lg border border-line p-5">
              <h3 className="font-mono text-sm font-bold text-fg">{t}</h3>
              <p className="mt-2 text-sm text-fg-muted">{b}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section
        id="deliver"
        index="09"
        label="Merge and deliver"
        title="Verified work is merged in order, and pushed only with your yes."
        lead="Verified attempts are merged in dependency order into brio/<mission>/integration. A conflict becomes a merge task of its own, given to the best merger with both diffs, the contracts and the handoffs, and verified like any task."
      >
        <ol className="grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-4">
          {[
            ["integrate", "merge verified branches in DAG order"],
            ["report", "what was done, by whom, which checks passed, what is open"],
            ["propose", "a branch, or a pull request on GitHub, waits in your inbox"],
            ["deliver", "approved, the runner pushes and opens the pull request with the project's token"],
          ].map(([t, b], i) => (
            <li key={t} className="bg-bg p-5">
              <span className="font-mono text-2xs text-fg-subtle">0{i + 1}</span>
              <p className="mt-1 font-mono text-sm font-bold text-fg">{t}</p>
              <p className="mt-1 text-sm text-fg-muted">{b}</p>
            </li>
          ))}
        </ol>
        <p className="mt-6 text-sm text-fg-muted">
          A person decides the delivery; an API token never can. Both the push and the pull request are
          entries in the audit ledger.
        </p>
      </Section>

      <Section
        id="events"
        index="10"
        label="Events"
        title="Every action is an event; the board is just a view of them."
        lead="Events are appended to one table and never changed. The board, the scoreboard, the ledger and your notifications all read from them, and the web app streams them over server-sent events."
      >
        <div className="grid gap-8 lg:grid-cols-[1fr_1.1fr]">
          <div className="space-y-4 text-sm text-fg-muted">
            <p>
              A reconnect resumes exactly where it left off (Last-Event-ID is the event&apos;s sequence
              number), so a dropped connection never loses a line.
            </p>
            <p>
              The scheduler is idempotent: it can crash and resume from the database. Leases and attempts
              carry heartbeats, and a reaper releases what was abandoned.
            </p>
            <p>Secrets are redacted before anything is written, at the adapter boundary.</p>
            <Link href={LINKS.architecture} className={secondary}>
              The architecture →
            </Link>
          </div>
          <Board />
        </div>
      </Section>

      <Section
        id="chat"
        index="11"
        label="Chat, underneath"
        title="A chat is a mission that stays open."
        lead="Chat reuses everything above. Each message is one task in a standing plan, carrying the conversation so far as quoted, untrusted context, so every reply gets routing, modes, budgets, policies, checks, the ledger and the scoreboard."
      >
        <Table
          head={["in chat", "runs as", "what happens"]}
          rows={CHAT_MODES.map((m) => [m.title, m.mode, m.body])}
          minWidth={600}
        />
        <p className="mt-6 text-sm text-fg-muted">
          One message at a time. A failed reply is revised or rerouted like any task and the chat stays open;
          a stopped reply stays stopped. When a question turns into real work, the chat becomes a mission with
          the conversation as its context.
        </p>
      </Section>

      <Cta
        title="See it on your own agents."
        lead="Run Brio in about fifteen minutes, connect one agent, and watch a mission go through every step on this page."
      />
    </>
  );
}
