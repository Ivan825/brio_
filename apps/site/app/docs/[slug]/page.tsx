import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DocEnhance } from "@/components/doc-enhance";
import { DocsNav } from "@/components/docs-nav";
import { DOCS, docBySlug, docHref, neighbours, renderDoc, sourceUrl } from "@/lib/docs";

export const dynamicParams = false;

export function generateStaticParams() {
  return DOCS.map((d) => ({ slug: d.slug }));
}

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const meta = docBySlug((await params).slug);
  return meta ? { title: meta.title, description: meta.summary } : {};
}

export default async function DocPage({ params }: Props) {
  const { slug } = await params;
  if (!docBySlug(slug)) notFound();
  const doc = renderDoc(slug);
  const { prev, next } = neighbours(slug);

  return (
    <div className="mx-auto grid max-w-6xl gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[200px_minmax(0,1fr)] xl:grid-cols-[200px_minmax(0,1fr)_200px]">
      <aside className="hidden lg:block">
        <div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto pb-10">
          <DocsNav current={slug} />
        </div>
      </aside>

      <article className="min-w-0">
        <details className="mb-6 rounded-md border border-line bg-surface lg:hidden">
          <summary className="cursor-pointer px-4 py-2.5 font-mono text-xs text-fg-muted">All docs</summary>
          <div className="border-t border-line px-4 py-4">
            <DocsNav current={slug} />
          </div>
        </details>

        <p className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-subtle">
          <Link href="/docs" className="hover:text-fg">
            docs
          </Link>{" "}
          / {doc.meta.group}
        </p>
        <h1 className="mt-3 font-mono text-xl font-bold tracking-tight text-fg sm:text-2xl">{doc.title}</h1>
        <p className="mt-3 text-md text-fg-muted">{doc.meta.summary}</p>

        {doc.toc.length > 2 ? (
          <details className="mt-6 rounded-md border border-line bg-surface xl:hidden">
            <summary className="cursor-pointer px-4 py-2.5 font-mono text-xs text-fg-muted">
              On this page
            </summary>
            <ul className="space-y-1 border-t border-line px-4 py-3">
              {doc.toc.map((t) => (
                <li key={t.id} className={t.depth === 3 ? "pl-3" : ""}>
                  <a href={`#${t.id}`} className="text-sm text-fg-muted hover:text-fg">
                    {t.text}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        <div
          id="doc-body"
          className="doc mt-8"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: the repository's own Markdown, rendered at build time with raw HTML escaped (lib/docs.ts)
          dangerouslySetInnerHTML={{ __html: doc.html }}
        />
        <DocEnhance root="doc-body" />

        <div className="mt-14 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6 font-mono text-2xs text-fg-subtle">
          <span>docs/{doc.meta.file}</span>
          <a href={sourceUrl(doc.meta.file)} className="hover:text-fg">
            View or edit on GitHub →
          </a>
        </div>
        <nav aria-label="Previous and next" className="mt-6 grid gap-3 sm:grid-cols-2">
          {prev ? (
            <Link
              href={docHref(prev.slug)}
              className="rounded-lg border border-line p-4 transition-colors duration-fast hover:border-line-strong"
            >
              <span className="font-mono text-2xs text-fg-subtle">← previous</span>
              <span className="mt-1 block text-sm text-fg">{prev.title}</span>
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link
              href={docHref(next.slug)}
              className="rounded-lg border border-line p-4 text-right transition-colors duration-fast hover:border-line-strong"
            >
              <span className="font-mono text-2xs text-fg-subtle">next →</span>
              <span className="mt-1 block text-sm text-fg">{next.title}</span>
            </Link>
          ) : null}
        </nav>
      </article>

      {doc.toc.length > 0 ? (
        <aside className="hidden xl:block">
          <nav
            aria-label="On this page"
            className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto pb-10"
          >
            <p className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-subtle">On this page</p>
            <ul className="mt-3 space-y-1.5">
              {doc.toc.map((t) => (
                <li key={t.id} className={t.depth === 3 ? "pl-3" : ""}>
                  <a href={`#${t.id}`} className="block text-xs leading-snug text-fg-muted hover:text-fg">
                    {t.text}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </aside>
      ) : null}
    </div>
  );
}
