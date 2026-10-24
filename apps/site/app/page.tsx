import { agentColorVar } from "@brio/brand";
import Image from "next/image";
import Link from "next/link";
import {
  A,
  Callout,
  Cards,
  Cta,
  Faq,
  HairlineGrid,
  primary,
  secondary,
  Table,
  Ticks,
  textLink,
} from "@/components/blocks";
import { Board } from "@/components/board";
import { ChatModes, Pipeline, RouterBars, WhereItRuns } from "@/components/diagrams";
import { Gallery } from "@/components/gallery";
import { Section } from "@/components/section";
import { Terminal } from "@/components/terminal";
import {
  AGENT_COUNTS,
  AGENTS,
  BY_HAND_VS_BRIO,
  CHECKS,
  CLI,
  CONNECTOR_COUNT,
  HOSTING,
  LINKS,
  MEASURED,
  SAFETY,
  SERVER_START,
  SHOTS,
  START,
  STEPS,
  WAYS_IN,
} from "@/lib/content";
import { CHAT_MODES, FAQ, PILLARS, TASK_GROUPS } from "@/lib/product";
import { byCategory } from "@/lib/registry";
import { at } from "@/lib/routes";

export default function Home() {
  const categories = byCategory();
  return (
    <>
      {/* Hero */}
      <section className="mx-auto max-w-6xl px-4 pb-20 pt-14 sm:px-6 sm:pt-20">
        <p className="inline-flex items-center gap-2 rounded-sm border border-line bg-surface px-2.5 py-1 font-mono text-xs text-fg-muted">
          <span className="h-1.5 w-1.5 rounded-xs bg-accent" aria-hidden />
          the conductor for AI agents · open source · self-hosted
        </p>
        <div className="mt-8 grid items-start gap-12 lg:grid-cols-[1.05fr_1fr]">
          <div>
            <h1 className="font-mono text-3xl font-bold tracking-tight text-fg sm:text-4xl">
              One goal.
              <br />
              Every AI.
            </h1>
            <p className="mt-6 max-w-xl text-md text-fg-muted">
              Chat with all your agents at once and let them answer together, review each other or debate. Or
              give Brio a goal: it plans it into tasks, sends each to the agent best at it, checks the results
              with another vendor, and hands you the verified outcome.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href={LINKS.gettingStarted} className={primary}>
                Get started
              </Link>
              <Link href="/how-it-works" className={secondary}>
                How it works
              </Link>
              <a href={LINKS.github} className={secondary}>
                Source on GitHub
              </a>
            </div>
            <dl className="mt-10 grid max-w-md grid-cols-3 gap-4 border-t border-line pt-6">
              {[
                [String(CONNECTOR_COUNT), "connectors"],
                [String(CHAT_MODES.length), "chat modes"],
                ["$0", "for Brio itself"],
              ].map(([v, l]) => (
                <div key={l}>
                  <dt className="sr-only">{l}</dt>
                  <dd className="font-mono text-xl font-bold text-fg">{v}</dd>
                  <dd className="font-mono text-2xs text-fg-subtle">{l}</dd>
                </div>
              ))}
            </dl>
          </div>
          <Board />
        </div>

        <div className="mt-16">
          <p className="font-mono text-xs uppercase tracking-[0.08em] text-fg-subtle">
            Drives {CONNECTOR_COUNT} connectors, including
          </p>
          <ul className="mt-4 flex flex-wrap gap-2" aria-label="Some of the agents and models Brio drives">
            {AGENTS.map((name, i) => (
              <li
                key={name}
                className="inline-flex items-center gap-2 rounded-sm border border-line px-2.5 py-1 font-mono text-xs text-fg-muted"
              >
                <span
                  className="h-1.5 w-1.5 rounded-xs"
                  style={{ background: agentColorVar(i) }}
                  aria-hidden
                />
                {name}
              </li>
            ))}
            <li className="inline-flex items-center rounded-sm border border-dashed border-line px-2.5 py-1 font-mono text-xs text-fg-subtle">
              any A2A agent
            </li>
          </ul>
        </div>
      </section>

      {/* Measured */}
      <section className="border-t border-line bg-surface" aria-label="Measured under load">
        <div className="mx-auto grid max-w-6xl grid-cols-2 gap-px bg-line lg:grid-cols-4">
          {MEASURED.map((m) => (
            <div key={m.label} className="bg-surface px-4 py-8 sm:px-6">
              <div className="font-mono text-2xl font-bold tabular-nums text-fg sm:text-3xl">
                {m.value}
                <span className="ml-1 text-md font-normal text-fg-subtle">{m.unit}</span>
              </div>
              <p className="mt-2 text-sm text-fg-muted">{m.label}</p>
            </div>
          ))}
        </div>
        <p className="mx-auto max-w-6xl px-4 py-3 font-mono text-2xs text-fg-subtle sm:px-6">
          Measured on one laptop with every process sharing it ·{" "}
          <Link href={LINKS.loadTest} className="underline decoration-line underline-offset-2 hover:text-fg">
            the load test
          </Link>
        </p>
      </section>

      <Section
        id="problem"
        index="01"
        label="The problem"
        title="Every agent is good at something. None of them knows the others exist."
        lead="You already use several. Today you are the router, the messenger and the reviewer between them: you pick who gets what by habit, copy context between chats and lose half of it, find collisions at merge time, and read every diff yourself."
      >
        <Table
          head={["", "By hand", "With Brio"]}
          rows={BY_HAND_VS_BRIO.map(([what, hand, brio]) => [
            what,
            <span key="h" className="text-fg-subtle">
              {hand}
            </span>,
            <span key="b" className="text-fg">
              {brio}
            </span>,
          ])}
          minWidth={640}
        />
      </Section>

      <Section
        id="what"
        index="02"
        label="What Brio is"
        title="The conductor, not another agent."
        lead="Brio has no model of its own. It sits above the agents you already pay for and gets the best result they can produce together, with proof, and better at it every run. Four things, together, that no single tool combines:"
      >
        <Cards items={PILLARS} cols={4} numbered />
        <p className="mt-6 text-sm text-fg-muted">
          Read the{" "}
          <Link href={LINKS.prd} className={textLink}>
            product requirements
          </Link>{" "}
          for the full reasoning, or the{" "}
          <Link href={LINKS.architecture} className={textLink}>
            architecture
          </Link>{" "}
          for how it is built.
        </p>
      </Section>

      <Section
        id="how"
        index="03"
        label="How it works"
        title="Plan, route, coordinate, verify, learn, govern."
        lead="One mission, six steps, every one of them an event you can watch and audit."
      >
        <Pipeline />
        <ol className="mt-10 grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-2 lg:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.key} className="flex min-w-0 flex-col bg-bg p-6">
              <span className="font-mono text-xs text-fg-subtle">0{i + 1}</span>
              <h3 className="mt-2 font-mono text-lg font-bold text-fg">{s.title}</h3>
              <p className="mt-2 flex-1 text-sm text-fg-muted">{s.body}</p>
              <code className="mt-4 block truncate rounded-sm border border-line bg-surface px-2 py-1.5 font-mono text-2xs text-fg-muted">
                {s.line}
              </code>
            </li>
          ))}
        </ol>
        <div className="mt-8">
          <Link href="/how-it-works" className={secondary}>
            The full walk-through →
          </Link>
        </div>
      </Section>

      <Section
        id="ways"
        index="04"
        label="Two ways to work"
        title="Ask a question, or hand over a goal."
        lead="Chat when you want an answer now. Run a mission when the work needs a plan, a repository, sandboxes and checks. A chat becomes a mission in one click, with the conversation as context."
      >
        <div className="grid gap-6 lg:grid-cols-2">
          {[
            {
              shot: "chat",
              title: "Chat",
              body: "Talk to all your agents the way you talk to one assistant.",
              points: [
                "the best agent for the question answers, or several build the reply",
                "follow-ups carry the conversation; replies arrive live",
                "each reply shows who worked on it, the cost and each agent's own answer",
                "rate a reply and the scoreboard learns from it",
              ],
            },
            {
              shot: "board",
              title: "Missions",
              body: "Give a goal; get a planned, routed, checked and merged result.",
              points: [
                "a plan of tasks with contracts, which you edit and approve",
                "a sandbox and a git worktree for every attempt",
                "a live board of lanes, handoffs, checks and cost",
                "a report and, on a repository, a pull request that waits for you",
              ],
            },
          ].map((w) => {
            const shot = SHOTS.find((s) => s.file === w.shot);
            return (
              <div
                key={w.title}
                className="flex flex-col overflow-hidden rounded-lg border border-line bg-surface"
              >
                <Image
                  src={`/shots/${w.shot}.jpg`}
                  alt={shot ? `${shot.title}: ${shot.caption}` : w.title}
                  width={1440}
                  height={900}
                  className="block h-auto w-full border-b border-line"
                />
                <div className="flex flex-1 flex-col p-6">
                  <h3 className="font-mono text-lg font-bold text-fg">{w.title}</h3>
                  <p className="mt-2 text-sm text-fg-muted">{w.body}</p>
                  <div className="mt-4">
                    <Ticks items={w.points} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      <Section
        id="modes"
        index="05"
        label="Many agents, one answer"
        title="Let them answer together, review each other, or debate."
        lead="Pick the agents above the message box and a mode. With one agent, Auto works; with two or more, the other three unlock. Missions have seven execution modes, from best-of-n to cascades."
      >
        <ChatModes />
        <p className="mt-6 text-sm text-fg-muted">
          Diversity is the point: in multi-agent modes Brio prefers agents from different vendors, because
          their mistakes correlate less.{" "}
          <Link href={at("how", "modes")} className={textLink}>
            All execution modes
          </Link>
          .
        </p>
      </Section>

      <Section
        id="agents"
        index="06"
        label="Bring your agents"
        title={`${CONNECTOR_COUNT} connectors across ${categories.length} categories.`}
        lead="Model APIs, coding CLIs, hosted agents, browser agents, media models, research tools, local models and any A2A agent. Model names are data: lists come live from each vendor, never hard-coded."
      >
        <HairlineGrid>
          {categories.map((c) => (
            <Link
              key={c.key}
              href={`${LINKS.connectors}#${c.slug}`}
              className="group bg-bg p-5 transition-colors duration-fast hover:bg-surface"
            >
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="font-mono text-sm font-bold text-fg">{c.label}</h3>
                <span className="font-mono text-xs text-accent">{c.names.length}</span>
              </div>
              <p className="mt-2 line-clamp-2 text-sm text-fg-muted">{c.names.slice(0, 6).join(" · ")}</p>
            </Link>
          ))}
          <Link
            href={LINKS.adapters}
            className="bg-bg p-5 transition-colors duration-fast hover:bg-surface sm:col-span-2 lg:col-span-2"
          >
            <h3 className="font-mono text-sm font-bold text-fg">Anything else</h3>
            <p className="mt-2 text-sm text-fg-muted">
              Any A2A agent or MCP server you add, local models through Ollama or vLLM, and your own adapter
              for whatever comes next.
            </p>
          </Link>
        </HairlineGrid>
        <div className="mt-10 grid gap-6 lg:grid-cols-[1fr_1.2fr]">
          <div>
            <h3 className="font-mono text-md font-bold text-fg">Works with what you have</h3>
            <p className="mt-2 text-sm text-fg-muted">
              Brio adapts to how many agents you connect, and says plainly what it could not do.
            </p>
          </div>
          <ul className="space-y-3">
            {AGENT_COUNTS.map((a) => (
              <li key={a.count} className="flex gap-4 rounded-md border border-line p-4">
                <span className="w-8 shrink-0 font-mono text-lg font-bold text-accent">{a.count}</span>
                <div>
                  <p className="text-sm font-medium text-fg">{a.title}</p>
                  <p className="mt-1 text-sm text-fg-muted">{a.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section
        id="verify"
        index="07"
        label="Verification"
        title="Nothing reaches you unchecked."
        lead="Each task's contract names its checks. Hard checks must pass; a failure goes back to an agent with the reason, not to you. The reviewer is never the maker's vendor."
      >
        <div className="grid gap-8 lg:grid-cols-2">
          <ul className="space-y-px self-start overflow-hidden rounded-lg border border-line bg-line">
            {CHECKS.map((c) => (
              <li key={c.name} className="flex items-center justify-between gap-4 bg-bg px-4 py-3">
                <span className="font-mono text-sm text-fg">{c.name}</span>
                <span className="text-right text-sm text-fg-muted">{c.detail}</span>
              </li>
            ))}
          </ul>
          <div className="space-y-4">
            <div className="rounded-lg border border-line bg-surface p-5 font-mono text-xs leading-relaxed">
              <p className="text-fg-subtle"># a task that fails, then passes</p>
              <p className="mt-2 text-fg">
                codex <span className="text-fg-subtle">→</span> t3 · tests{" "}
                <span className="text-danger">2 failed</span>
              </p>
              <p className="text-fg">
                brio <span className="text-fg-subtle">→</span> t3 · revise 1/2 · failures sent back
              </p>
              <p className="text-fg">
                codex <span className="text-fg-subtle">→</span> t3 · tests{" "}
                <span className="text-success">passed</span>
              </p>
              <p className="text-fg">
                gemini <span className="text-fg-subtle">→</span> review t3 ·{" "}
                <span className="text-success">pass</span>
              </p>
              <p className="text-fg">
                brio <span className="text-fg-subtle">→</span> t3 done · handoff written
              </p>
            </div>
            <p className="text-sm text-fg-muted">
              Two failed revisions reroute the task to the next-best agent; a third failure proposes a new
              plan. Every result arrives with its evidence: test output, the typecheck, the reviewer&apos;s
              reasons and the diff.
            </p>
          </div>
        </div>
      </Section>

      <Section
        id="learn"
        index="08"
        label="It learns"
        title="Routing on evidence, not habit."
        lead="Every verdict updates a scoreboard of who wins at which kind of task, at what cost and speed. The router samples from it, weighs price and time by the mission's priority, and writes down why it chose."
      >
        <div className="grid gap-8 lg:grid-cols-[1.2fr_1fr]">
          <RouterBars />
          <div className="space-y-4 text-sm text-fg-muted">
            <p>
              Scores are kept per task type:{" "}
              <span className="font-mono text-fg">{TASK_GROUPS.flatMap((g) => g.types).length}</span> types
              across code, design, research, writing, data, media and browser work. Pass rates are Beta
              posteriors, head-to-head results are Elo, and cost and latency are moving averages.
            </p>
            <p>
              Scores decay slowly, so a new model can climb; a new model of a known agent starts from its
              predecessor&apos;s record. Your thumbs up and down count too.
            </p>
            <p>
              Optionally, and only if you opt in both ways, workspaces pool anonymised outcomes so a new agent
              does not start from nothing.
            </p>
            <Link href={at("how", "learn")} className={textLink}>
              How the scoreboard works →
            </Link>
          </div>
        </div>
      </Section>

      <Section
        id="safety"
        index="09"
        label="Your machines, your data"
        title="Your keys, your machines, your rules."
        lead="No account with us and no cloud of ours. Nothing leaves your machines except the calls to the vendors you connected, with your keys."
      >
        <WhereItRuns />
        <div className="mt-10">
          <Cards items={SAFETY} />
        </div>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/security" className={secondary}>
            The security model →
          </Link>
          <Link href={LINKS.securityReview} className={secondary}>
            The security review
          </Link>
        </div>
      </Section>

      <section id="see" className="border-t border-line py-20 sm:py-28" aria-labelledby="see-title">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.08em] text-fg-subtle">
                <span className="text-accent">10</span> · See it run
              </p>
              <h2
                id="see-title"
                className="mt-3 font-mono text-2xl font-bold tracking-tight text-fg sm:text-3xl"
              >
                The real app, not a mock-up.
              </h2>
            </div>
            <p className="max-w-md text-sm text-fg-muted">
              {SHOTS.length} screens from a chat and a mission, run against Brio&apos;s scripted test vendor
              so it is the same every time. With your agents, the board fills with theirs.
            </p>
          </div>
          <div className="mt-10">
            <Gallery />
          </div>
        </div>
      </section>

      <Section
        id="ways-in"
        index="11"
        label="Ways in"
        title="Use it from wherever you already work."
        lead="The web app is one door. Your terminal, your editor's agent, other A2A agents and your own code are the others."
      >
        <div className="grid items-start gap-8 lg:grid-cols-2">
          <Table
            caption="Ways in"
            rows={WAYS_IN.map((w) => [
              w.from,
              <span key="h" className="font-mono text-xs">
                {w.how}
              </span>,
            ])}
            mono={false}
            minWidth={0}
          />
          <Table
            caption="The brio CLI: npm install -g brio-orchestrator"
            rows={CLI.map(([cmd, what]) => [cmd, what])}
            minWidth={0}
          />
        </div>
      </Section>

      <Section
        id="start"
        index="12"
        label="Host it yourself"
        title="Running on your own machine in about fifteen minutes."
        lead="Brio is self-hosted: there is no Brio cloud, no account with us and no domain to buy. Pick a machine; Docker is all it needs."
      >
        <div className="mb-10 grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-3">
          {HOSTING.map((h) => (
            <div key={h.title} className="flex flex-col bg-bg p-6">
              <div className="flex items-center gap-2">
                <h3 className="font-mono text-sm font-bold text-fg">{h.title}</h3>
                <span className="rounded-xs border border-line px-1.5 font-mono text-2xs text-accent">
                  {h.tag}
                </span>
              </div>
              <p className="mt-2 flex-1 text-sm text-fg-muted">{h.body}</p>
              <p className="mt-3 font-mono text-2xs text-fg-subtle">{h.needs}</p>
              {h.alt ? <p className="mt-1 font-mono text-2xs text-fg-subtle">{h.alt}</p> : null}
              <A href={LINKS[h.link]} className={`mt-4 self-start text-sm ${textLink}`}>
                {h.cta} →
              </A>
            </div>
          ))}
        </div>
        <Terminal
          tabs={[
            { label: "a fresh Ubuntu server", commands: SERVER_START },
            { label: "your computer", commands: START },
          ]}
        />
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href={LINKS.deployCloud} className={secondary}>
            Deploy on a server
          </Link>
          <Link href={LINKS.selfHost} className={secondary}>
            Self-hosting guide
          </Link>
          <Link href={LINKS.ownerSetup} className={secondary}>
            Set up without a domain
          </Link>
        </div>
      </Section>

      <Section id="faq" index="13" label="Questions" title="Questions people ask first.">
        <Faq items={FAQ} />
      </Section>

      <Callout>
        Brio&apos;s own build was planned in one agent and built in another, with a handoff packet between
        them.
      </Callout>

      <Cta
        title="Every AI, one ensemble."
        lead="Stop being the messenger between your agents. Give Brio the goal."
      />
    </>
  );
}
