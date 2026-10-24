import type { Metadata } from "next";
import Link from "next/link";
import { PageHero, textLink } from "@/components/blocks";
import { DocsSearch } from "@/components/docs-search";
import { Terminal } from "@/components/terminal";
import { LINKS, REPO, SERVER_START, START } from "@/lib/content";

export const metadata: Metadata = {
  title: "Docs",
  description:
    "Brio's documentation: getting started, hosting, connectors, the API, architecture and security.",
};

const PATHS = [
  {
    title: "I want to try it",
    steps: ["Run it on your computer", "Connect one agent", "Chat, then run a mission"],
    href: LINKS.gettingStarted,
    cta: "Getting started",
  },
  {
    title: "I want it always on",
    steps: ["A free student server or any Ubuntu box", "A free address with HTTPS", "Automatic updates"],
    href: LINKS.deployCloud,
    cta: "Deploy on a server",
  },
  {
    title: "I want to build on it",
    steps: ["The REST API and tokens", "MCP and A2A", "A new adapter for any agent"],
    href: LINKS.api,
    cta: "API reference",
  },
] as const;

export default function DocsIndex() {
  return (
    <>
      <PageHero
        label="~/docs"
        title="Documentation"
        lead="Everything here is the repository's own docs/ folder, published as it is on GitHub: the guides, the API reference, the architecture and every decision."
      />
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-3">
          {PATHS.map((p) => (
            <div key={p.title} className="flex flex-col bg-bg p-6">
              <h2 className="font-mono text-sm font-bold text-fg">{p.title}</h2>
              <ol className="mt-3 flex-1 space-y-1.5">
                {p.steps.map((s, i) => (
                  <li key={s} className="flex gap-2 text-sm text-fg-muted">
                    <span className="font-mono text-fg-subtle">{i + 1}</span>
                    {s}
                  </li>
                ))}
              </ol>
              <Link href={p.href} className={`mt-5 self-start text-sm ${textLink}`}>
                {p.cta} →
              </Link>
            </div>
          ))}
        </div>

        <div className="mt-14">
          <DocsSearch />
        </div>

        <div className="mt-16 grid gap-8 lg:grid-cols-[1fr_1.3fr]">
          <div>
            <h2 className="font-mono text-lg font-bold text-fg">The shortest way in</h2>
            <p className="mt-2 text-sm text-fg-muted">
              Docker is all Brio needs. On your own computer it is three commands; on a fresh server, five.
              Then open the address, sign in and follow{" "}
              <Link href={LINKS.gettingStarted} className={textLink}>
                Getting started
              </Link>
              .
            </p>
            <p className="mt-4 text-sm text-fg-muted">
              Something wrong or missing in the docs?{" "}
              <a href={`${REPO}/issues`} className={textLink}>
                Open an issue
              </a>
              .
            </p>
          </div>
          <Terminal
            tabs={[
              { label: "your computer", commands: START },
              { label: "a fresh Ubuntu server", commands: SERVER_START },
            ]}
          />
        </div>
      </div>
    </>
  );
}
