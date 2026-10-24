import Link from "next/link";
import { DOC_GROUPS, DOCS, docHref } from "@/lib/docs-index";

/** Every doc, by group; the current one marked. */
export function DocsNav({ current }: { current?: string }) {
  return (
    <nav aria-label="Docs" className="space-y-6">
      <Link
        href="/docs"
        aria-current={current === undefined ? "page" : undefined}
        className={`block font-mono text-xs ${current === undefined ? "text-accent" : "text-fg-muted hover:text-fg"}`}
      >
        ~/docs
      </Link>
      {DOC_GROUPS.map((g) => (
        <div key={g}>
          <p className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-subtle">{g}</p>
          <ul className="mt-2 space-y-0.5 border-l border-line">
            {DOCS.filter((d) => d.group === g).map((d) => {
              const active = d.slug === current;
              return (
                <li key={d.slug}>
                  <Link
                    href={docHref(d.slug)}
                    aria-current={active ? "page" : undefined}
                    className={`-ml-px block border-l py-1 pl-3 text-sm transition-colors duration-fast ${active ? "border-accent text-fg" : "border-transparent text-fg-muted hover:border-line-strong hover:text-fg"}`}
                  >
                    {d.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
