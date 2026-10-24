import { BRAND } from "@brio/brand";
import Link from "next/link";
import type { ReactNode } from "react";
import { DOCS, REPO_URL } from "@/lib/docs";

const SECTIONS = ["Start", "Use", "Extend", "Under the hood"] as const;

/** The documentation: public, no sign-in. */
export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-bg text-fg">
      <header className="sticky top-0 z-10 border-b border-line bg-bg backdrop-blur">
        <div className="mx-auto flex h-12 max-w-6xl items-center gap-4 px-4">
          <Link href="/docs" className="font-mono text-md font-bold tracking-tight">
            {BRAND.wordmark}
            <span className="text-accent">_</span> <span className="font-normal text-fg-muted">docs</span>
          </Link>
          <nav aria-label="Elsewhere" className="ml-auto flex items-center gap-4 text-sm text-fg-muted">
            <Link href="/missions" className="hover:text-fg">
              Open Brio
            </Link>
            <a href={REPO_URL} rel="noreferrer" className="hover:text-fg">
              GitHub
            </a>
          </nav>
        </div>
      </header>
      <div className="mx-auto flex max-w-6xl gap-8 px-4 py-8">
        <nav aria-label="Documentation" className="hidden w-52 shrink-0 md:block">
          {SECTIONS.map((section) => (
            <div key={section} className="mb-5">
              <p className="mb-1.5 font-mono text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                {section}
              </p>
              <ul className="flex flex-col gap-0.5">
                {DOCS.filter((d) => d.section === section).map((d) => (
                  <li key={d.slug}>
                    <Link
                      href={`/docs/${d.slug}`}
                      className="block rounded-sm px-2 py-1 text-sm text-fg-muted hover:bg-surface-2 hover:text-fg"
                    >
                      {d.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
