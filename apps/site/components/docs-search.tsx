"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { HairlineGrid } from "@/components/blocks";
import { DOC_GROUPS, DOCS, docHref } from "@/lib/docs-index";

/** The docs index: every doc by group, narrowed as you type. */
export function DocsSearch() {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return DOCS.filter((d) => {
      const text = `${d.title} ${d.summary} ${d.group} ${d.file}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }, [q]);

  return (
    <div>
      <label className="block">
        <span className="sr-only">Filter the docs</span>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter the docs: deploy, email, budgets, API…"
          className="w-full rounded-md border border-line bg-surface px-4 py-3 font-mono text-sm text-fg placeholder:text-fg-subtle focus:border-line-strong focus:outline-none"
        />
      </label>
      <p className="mt-2 font-mono text-2xs text-fg-subtle" aria-live="polite">
        {shown.length} of {DOCS.length} docs
      </p>
      <div className="mt-8 space-y-10">
        {DOC_GROUPS.map((g) => {
          const docs = shown.filter((d) => d.group === g);
          if (docs.length === 0) return null;
          return (
            <section key={g} aria-label={g}>
              <h2 className="font-mono text-xs uppercase tracking-[0.08em] text-fg-subtle">{g}</h2>
              <div className="mt-3">
                <HairlineGrid>
                  {docs.map((d) => (
                    <div key={d.slug} className="bg-bg">
                      <Link
                        href={docHref(d.slug)}
                        className="flex h-full flex-col p-5 transition-colors duration-fast hover:bg-surface"
                      >
                        <span className="font-mono text-sm font-bold text-fg">{d.title}</span>
                        <span className="mt-2 flex-1 text-sm text-fg-muted">{d.summary}</span>
                        <span className="mt-3 font-mono text-2xs text-fg-subtle">docs/{d.file}</span>
                      </Link>
                    </div>
                  ))}
                </HairlineGrid>
              </div>
            </section>
          );
        })}
        {shown.length === 0 ? (
          <p className="text-sm text-fg-muted">
            Nothing matches. Try a shorter word, or search the repository on GitHub.
          </p>
        ) : null}
      </div>
    </div>
  );
}
