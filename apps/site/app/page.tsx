import { agentColorVar, BRAND } from "@brio/brand";
import { Board } from "@/components/board";
import { Gallery } from "@/components/gallery";
import { Section, Wordmark } from "@/components/section";
import { Terminal } from "@/components/terminal";
import {
  AGENT_COUNTS,
  AGENTS,
  BY_HAND_VS_BRIO,
  CHECKS,
  CLI,
  CONNECTOR_COUNT,
  doc,
  FEATURES,
  FLOW,
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

const NAV = [
  { href: "#see", label: "See it run" },
  { href: "#how", label: "How it works" },
  { href: "#verify", label: "Verification" },
  { href: "#safety", label: "Safety" },
  { href: "#start", label: "Host it" },
] as const;

const button =
  "inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors duration-fast";
const primary = `${button} bg-primary text-primary-fg hover:bg-primary-hover`;
const secondary = `${button} border border-line text-fg hover:border-line-strong hover:bg-surface`;

export default function Home() {
  return (
    <>
      <header className="sticky top-0 z-10 border-b border-line bg-bg">
        <nav
          className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6"
          aria-label="Main"
        >
          <a href="#top" className="text-lg" aria-label={`${BRAND.name}, back to the top`}>
            <Wordmark />
          </a>
          <div className="hidden items-center gap-6 md:flex">
            {NAV.map((n) => (
              <a key={n.href} href={n.href} className="text-sm text-fg-muted hover:text-fg">
                {n.label}
              </a>
            ))}
            <a href={LINKS.gettingStarted} className="text-sm text-fg-muted hover:text-fg">
              Docs
            </a>
          </div>
          <a href={LINKS.github} className={`${secondary} py-1.5`}>
            GitHub
          </a>
        </nav>
      </header>

      <main id="top">
        {/* Hero */}
        <section className="mx-auto max-w-6xl px-4 pb-20 pt-16 sm:px-6 sm:pt-24">
          <p className="inline-flex items-center gap-2 rounded-sm border border-line bg-surface px-2.5 py-1 font-mono text-xs text-fg-muted">
            <span className="h-1.5 w-1.5 rounded-xs bg-accent" aria-hidden />
            the conductor for AI agents · open source
          </p>
          <div className="mt-8 grid items-start gap-12 lg:grid-cols-[1.05fr_1fr]">
            <div>
              <h1 className="font-mono text-3xl font-bold tracking-tight text-fg sm:text-4xl">
                One goal.
                <br />
                Every AI.
              </h1>
              <p className="mt-6 max-w-xl text-md text-fg-muted">
                Chat with all your agents at once and let them answer together, review each other or debate.
                Or give Brio a goal: it plans it into tasks, sends each to the agent best at it, checks the
                results with another vendor, and hands you the verified outcome.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <a href={LINKS.github} className={primary}>
                  Get the source
                </a>
                <a href="#start" className={secondary}>
                  Run it in 15 minutes
                </a>
                <a href={LINKS.gettingStarted} className={secondary}>
                  Read the docs
                </a>
              </div>
              <p className="mt-8 font-mono text-xs text-fg-subtle">
                It is the conductor, not another agent. You bring the agents.
              </p>
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
            <a href={LINKS.loadTest} className="underline decoration-line underline-offset-2 hover:text-fg">
              the load test
            </a>
          </p>
        </section>

        <section id="see" className="mx-auto max-w-6xl px-4 py-20 sm:px-6" aria-labelledby="see-title">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.08em] text-fg-subtle">See it run</p>
              <h2 id="see-title" className="mt-3 font-mono text-2xl font-bold tracking-tight text-fg">
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
        </section>

        <Section
          id="problem"
          index="01"
          label="The problem"
          title="Every agent is good at something. None of them knows the others exist."
          lead="You already use several. Today you are the router, the messenger and the reviewer between them."
        >
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="bg-surface font-mono text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                <tr>
                  <th scope="col" className="px-4 py-3 font-normal" />
                  <th scope="col" className="px-4 py-3 font-normal">
                    By hand
                  </th>
                  <th scope="col" className="px-4 py-3 font-normal text-accent">
                    With Brio
                  </th>
                </tr>
              </thead>
              <tbody>
                {BY_HAND_VS_BRIO.map(([what, hand, brio]) => (
                  <tr key={what} className="border-t border-line">
                    <th scope="row" className="px-4 py-3 font-mono text-xs font-normal text-fg">
                      {what}
                    </th>
                    <td className="px-4 py-3 text-fg-subtle">{hand}</td>
                    <td className="px-4 py-3 text-fg">{brio}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section
          id="how"
          index="02"
          label="How it works"
          title="Plan, route, coordinate, verify, learn, govern."
          lead="One mission, six steps, every one of them an event you can watch and audit."
        >
          <ol className="grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-2 lg:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.key} className="flex flex-col bg-bg p-6">
                <span className="font-mono text-xs text-fg-subtle">0{i + 1}</span>
                <h3 className="mt-2 font-mono text-lg font-bold text-fg">{s.title}</h3>
                <p className="mt-2 flex-1 text-sm text-fg-muted">{s.body}</p>
                <code className="mt-4 block truncate rounded-sm border border-line bg-surface px-2 py-1.5 font-mono text-2xs text-fg-muted">
                  {s.line}
                </code>
              </li>
            ))}
          </ol>
        </Section>

        <Section
          id="verify"
          index="03"
          label="Verification"
          title="Nothing reaches you unchecked."
          lead="Each task's contract names its checks. Hard checks must pass; a failure goes back to an agent with the reason, not to you."
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
            <div>
              <h3 className="font-mono text-md font-bold text-fg">Works with what you have</h3>
              <ul className="mt-4 space-y-3">
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
          </div>
        </Section>

        <Section
          id="safety"
          index="04"
          label="Your machines, your data"
          title="Your keys, your machines, your rules."
          lead="No account with us and no cloud of ours. Nothing leaves your machines except the calls to the vendors you connected, with your keys."
        >
          <ol className="mb-10 grid gap-3 md:grid-cols-4" aria-label="Where things run">
            {FLOW.map((f, i) => (
              <li key={f.name} className="relative rounded-lg border border-line bg-surface p-4">
                <p className="font-mono text-sm font-bold text-fg">{f.name}</p>
                <ul className="mt-2 space-y-1">
                  {f.items.map((item) => (
                    <li key={item} className="font-mono text-2xs text-fg-muted">
                      {item}
                    </li>
                  ))}
                </ul>
                {i < FLOW.length - 1 ? (
                  <span
                    className="absolute -right-3 top-1/2 z-[1] hidden -translate-y-1/2 font-mono text-md text-accent md:block"
                    aria-hidden
                  >
                    →
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
          <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
            {SAFETY.map((s) => (
              <div key={s.title} className="bg-bg p-6">
                <h3 className="font-mono text-sm font-bold text-fg">{s.title}</h3>
                <p className="mt-2 text-sm text-fg-muted">{s.body}</p>
              </div>
            ))}
          </div>
          <p className="mt-6 text-sm text-fg-muted">
            Read the{" "}
            <a href={LINKS.security} className="text-fg underline decoration-line underline-offset-2">
              security model
            </a>{" "}
            and the{" "}
            <a
              href={doc("SECURITY_REVIEW.md")}
              className="text-fg underline decoration-line underline-offset-2"
            >
              security review
            </a>
            .
          </p>
        </Section>

        <Section
          id="start"
          index="05"
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
                <a
                  href={LINKS[h.link]}
                  className="mt-4 self-start text-sm text-fg underline decoration-line underline-offset-2 hover:decoration-fg"
                >
                  {h.cta} →
                </a>
              </div>
            ))}
          </div>
          <div className="grid gap-8 lg:grid-cols-[1.1fr_1fr]">
            <Terminal
              tabs={[
                { label: "a fresh Ubuntu server", commands: SERVER_START },
                { label: "your computer", commands: START },
              ]}
            />
            <div className="overflow-hidden rounded-lg border border-line">
              <table className="w-full text-left text-sm">
                <caption className="border-b border-line bg-surface px-4 py-2 text-left font-mono text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                  Ways in
                </caption>
                <tbody>
                  {WAYS_IN.map((w) => (
                    <tr key={w.from} className="border-t border-line first:border-t-0">
                      <th scope="row" className="w-40 px-4 py-2.5 align-top text-sm font-normal text-fg">
                        {w.from}
                      </th>
                      <td className="px-4 py-2.5 font-mono text-xs text-fg-muted">{w.how}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href={LINKS.selfHost} className={secondary}>
              Self-hosting guide
            </a>
            <a href={LINKS.ownerSetup} className={secondary}>
              Set up without a domain
            </a>
            <a href={LINKS.adapters} className={secondary}>
              Write an adapter
            </a>
            <a href={LINKS.api} className={secondary}>
              API reference
            </a>
          </div>
          <div className="mt-10 overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[560px] text-left text-sm">
              <caption className="border-b border-line bg-surface px-4 py-2 text-left font-mono text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                The brio CLI
              </caption>
              <tbody>
                {CLI.map(([cmd, what]) => (
                  <tr key={cmd} className="border-t border-line first:border-t-0">
                    <th
                      scope="row"
                      className="w-64 px-4 py-2.5 text-left font-mono text-xs font-normal text-fg"
                    >
                      {cmd}
                    </th>
                    <td className="px-4 py-2.5 text-sm text-fg-muted">{what}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section id="features" index="06" label="Everything else" title="Built for many agents at once.">
          <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, i) => (
              <div key={f.title} className="bg-bg p-6">
                <span className="font-mono text-xs text-fg-subtle">0{i + 1}</span>
                <h3 className="mt-2 font-mono text-sm font-bold text-fg">{f.title}</h3>
                <p className="mt-2 text-sm text-fg-muted">{f.body}</p>
              </div>
            ))}
          </div>
        </Section>

        <section className="border-t border-line py-24">
          <div className="mx-auto max-w-6xl px-4 text-center sm:px-6">
            <p className="font-mono text-3xl font-bold tracking-tight text-fg sm:text-4xl">{BRAND.tagline}</p>
            <p className="mx-auto mt-4 max-w-xl text-md text-fg-muted">
              Stop being the messenger between your agents. Give Brio the goal.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <a href={LINKS.github} className={primary}>
                Get the source on GitHub
              </a>
              <a href={LINKS.gettingStarted} className={secondary}>
                Getting started
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-fg-subtle sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <Wordmark />
          <nav className="flex flex-wrap gap-5" aria-label="Footer">
            <a href={LINKS.github} className="hover:text-fg">
              GitHub
            </a>
            <a href={LINKS.gettingStarted} className="hover:text-fg">
              Docs
            </a>
            <a href={LINKS.architecture} className="hover:text-fg">
              Architecture
            </a>
            <a href={LINKS.changelog} className="hover:text-fg">
              Changelog
            </a>
          </nav>
          <span className="font-mono text-xs">AGPL-3.0 · © 2026</span>
        </div>
      </footer>
    </>
  );
}
