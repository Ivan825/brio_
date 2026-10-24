import { BRAND } from "@brio/brand";
import type { Metadata } from "next";
import Link from "next/link";
import { DOCS } from "@/lib/docs";

export const metadata: Metadata = { title: "Docs" };

export default function DocsIndex() {
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <p className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">documentation</p>
        <h1 className="text-2xl font-semibold tracking-tight">{BRAND.name}</h1>
        <p className="max-w-2xl text-fg-muted">{BRAND.description}</p>
      </header>
      <ul className="grid gap-3 sm:grid-cols-2" data-testid="docs-index">
        {DOCS.map((d) => (
          <li key={d.slug}>
            <Link
              href={`/docs/${d.slug}`}
              className="flex h-full flex-col gap-1 rounded-lg border border-line bg-surface p-4 hover:border-line-strong"
            >
              <span className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                {d.section}
              </span>
              <span className="font-medium text-fg">{d.title}</span>
              <span className="text-sm text-fg-muted">{d.summary}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
