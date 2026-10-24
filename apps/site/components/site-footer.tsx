import { BRAND } from "@brio/brand";
import Link from "next/link";
import { Wordmark } from "@/components/section";
import { LINKS } from "@/lib/content";
import { PAGES } from "@/lib/routes";

const COLUMNS = [
  {
    title: "Product",
    links: [
      { href: PAGES.home.path, label: "Overview" },
      { href: PAGES.how.path, label: "How it works" },
      { href: PAGES.features.path, label: "Features" },
      { href: PAGES.security.path, label: "Security" },
    ],
  },
  {
    title: "Docs",
    links: [
      { href: LINKS.gettingStarted, label: "Getting started" },
      { href: LINKS.deployCloud, label: "Deploy on a server" },
      { href: LINKS.selfHost, label: "Self-hosting" },
      { href: LINKS.connectors, label: "Connectors" },
      { href: LINKS.api, label: "API reference" },
    ],
  },
  {
    title: "Project",
    links: [
      { href: LINKS.architecture, label: "Architecture" },
      { href: LINKS.decisions, label: "Decisions" },
      { href: LINKS.changelog, label: "Changelog" },
      { href: LINKS.securityReview, label: "Security review" },
      { href: LINKS.loadTest, label: "Load test" },
    ],
  },
] as const;

/** Links to every part of the site, the source and the licence. */
export function SiteFooter() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div>
          <Link href="/" className="text-lg" aria-label={`${BRAND.name}, home`}>
            <Wordmark />
          </Link>
          <p className="mt-3 max-w-xs text-sm text-fg-muted">
            {BRAND.tagline} The conductor for your AI agents: plan, route, verify, learn, govern.
          </p>
          <div className="mt-5 flex gap-3">
            <a
              href={LINKS.github}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-fg transition-colors duration-fast hover:border-line-strong"
            >
              Source on GitHub
            </a>
          </div>
        </div>
        {COLUMNS.map((c) => (
          <nav key={c.title} aria-label={c.title}>
            <p className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-subtle">{c.title}</p>
            <ul className="mt-3 space-y-2">
              {c.links.map((l) => (
                <li key={l.href}>
                  <Link
                    href={l.href}
                    className="text-sm text-fg-muted transition-colors duration-fast hover:text-fg"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-5 font-mono text-2xs text-fg-subtle sm:flex-row sm:justify-between sm:px-6">
          <span>
            <a href={LINKS.licence} className="hover:text-fg">
              AGPL-3.0
            </a>{" "}
            · © 2026 · self-hosted, bring your own keys
          </span>
          <a href={LINKS.issues} className="hover:text-fg">
            Report an issue
          </a>
        </div>
      </div>
    </footer>
  );
}
