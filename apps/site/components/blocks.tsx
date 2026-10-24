import Link from "next/link";
import type { ReactNode } from "react";
import { CopyButton } from "@/components/copy";

const button =
  "inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors duration-fast";
export const primary = `${button} bg-primary text-primary-fg hover:bg-primary-hover`;
export const secondary = `${button} border border-line text-fg hover:border-line-strong hover:bg-surface`;
export const textLink = "text-fg underline decoration-line underline-offset-2 hover:decoration-fg";

/** A link that stays on the site when it can (next/link) and leaves it otherwise. */
export function A({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  return href.startsWith("/") ? (
    <Link href={href} className={className}>
      {children}
    </Link>
  ) : (
    <a href={href} className={className}>
      {children}
    </a>
  );
}

/** The top of every page but the home page: a mono label, a large title, a lead and actions. */
export function PageHero({
  label,
  title,
  lead,
  children,
}: {
  label: string;
  title: ReactNode;
  lead: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="border-b border-line">
      <div className="mx-auto max-w-6xl px-4 pb-14 pt-14 sm:px-6 sm:pb-20 sm:pt-20">
        <p className="inline-flex items-center gap-2 rounded-sm border border-line bg-surface px-2.5 py-1 font-mono text-xs text-fg-muted">
          <span className="h-1.5 w-1.5 rounded-xs bg-accent" aria-hidden />
          {label}
        </p>
        <h1 className="mt-6 max-w-4xl font-mono text-2xl font-bold tracking-tight text-fg sm:text-3xl">
          {title}
        </h1>
        <p className="mt-5 max-w-2xl text-md text-fg-muted">{lead}</p>
        {children ? <div className="mt-8">{children}</div> : null}
      </div>
    </section>
  );
}

/** Jump links to a page's sections. */
export function OnThisPage({ items }: { items: ReadonlyArray<{ id: string; label: string }> }) {
  return (
    <nav aria-label="On this page" className="flex flex-wrap gap-2">
      {items.map((i, n) => (
        <a
          key={i.id}
          href={`#${i.id}`}
          className="rounded-sm border border-line px-2.5 py-1 font-mono text-2xs text-fg-muted transition-colors duration-fast hover:border-line-strong hover:text-fg"
        >
          <span className="text-fg-subtle">{String(n + 1).padStart(2, "0")}</span> {i.label}
        </a>
      ))}
    </nav>
  );
}

/** A grid of cards separated by hairlines. */
export function Cards({
  items,
  cols = 3,
  numbered = false,
}: {
  items: ReadonlyArray<{ title: ReactNode; body: ReactNode; meta?: ReactNode }>;
  cols?: 2 | 3 | 4;
  numbered?: boolean;
}) {
  const grid = {
    2: "sm:grid-cols-2",
    3: "sm:grid-cols-2 lg:grid-cols-3",
    4: "sm:grid-cols-2 lg:grid-cols-4",
  }[cols];
  return (
    <div className={`grid gap-px overflow-hidden rounded-lg border border-line bg-line ${grid}`}>
      {items.map((c, i) => (
        <div key={typeof c.title === "string" ? c.title : i} className="flex flex-col bg-bg p-6">
          {numbered ? (
            <span className="font-mono text-xs text-fg-subtle">{String(i + 1).padStart(2, "0")}</span>
          ) : null}
          <h3 className={`font-mono text-sm font-bold text-fg ${numbered ? "mt-2" : ""}`}>{c.title}</h3>
          <div className="mt-2 flex-1 text-sm text-fg-muted">{c.body}</div>
          {c.meta ? <div className="mt-4 font-mono text-2xs text-fg-subtle">{c.meta}</div> : null}
        </div>
      ))}
    </div>
  );
}

/** A two-column table of names and what they mean, scrolling sideways on its own when narrow. */
export function Table({
  caption,
  head,
  rows,
  mono = true,
  minWidth = 520,
}: {
  caption?: string;
  head?: readonly string[];
  rows: ReadonlyArray<readonly ReactNode[]>;
  mono?: boolean;
  minWidth?: number;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full text-left text-sm" style={{ minWidth }}>
        {caption ? (
          <caption className="border-b border-line bg-surface px-4 py-2 text-left font-mono text-2xs uppercase tracking-[0.08em] text-fg-subtle">
            {caption}
          </caption>
        ) : null}
        {head ? (
          <thead className="bg-surface font-mono text-2xs uppercase tracking-[0.08em] text-fg-subtle">
            <tr>
              {head.map((h) => (
                <th key={h} scope="col" className="px-4 py-2.5 font-normal">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {rows.map((r, i) => (
            <tr key={typeof r[0] === "string" ? r[0] : i} className="border-t border-line first:border-t-0">
              {r.map((cell, j) => {
                const key = `${i}-${j}`;
                return j === 0 ? (
                  <th
                    key={key}
                    scope="row"
                    className={`px-4 py-2.5 align-top font-normal text-fg ${mono ? "font-mono text-xs" : "text-sm"}`}
                  >
                    {cell}
                  </th>
                ) : (
                  <td key={key} className="px-4 py-2.5 align-top text-fg-muted">
                    {cell}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A block of code or log output with a label and a copy button. */
export function Code({ label, children, copy = true }: { label: string; children: string; copy?: boolean }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
        <span className="font-mono text-2xs text-fg-subtle">{label}</span>
        {copy ? <CopyButton text={children} /> : null}
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-fg">
        <code>{children}</code>
      </pre>
    </div>
  );
}

/** A short list with brass ticks. */
export function Ticks({ items }: { items: readonly ReactNode[] }) {
  return (
    <ul className="space-y-2">
      {items.map((t, i) => (
        <li key={typeof t === "string" ? t : i} className="flex gap-3 text-sm text-fg-muted">
          <span className="mt-0.5 font-mono text-accent" aria-hidden>
            ✓
          </span>
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

/** A full-width strip with one sentence in it. */
export function Callout({ children }: { children: ReactNode }) {
  return (
    <section className="border-t border-line bg-surface">
      <p className="mx-auto max-w-6xl px-4 py-10 text-center font-mono text-sm uppercase tracking-[0.08em] text-fg sm:px-6 sm:text-base">
        {children}
      </p>
    </section>
  );
}

/** Questions and answers that open in place. */
export function Faq({ items }: { items: ReadonlyArray<{ q: string; a: ReactNode }> }) {
  return (
    <div className="divide-y divide-line overflow-hidden rounded-lg border border-line">
      {items.map((f) => (
        <details key={f.q} className="group bg-bg open:bg-surface">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-sm font-medium text-fg">
            {f.q}
            <span
              className="font-mono text-accent transition-transform duration-fast group-open:rotate-45"
              aria-hidden
            >
              +
            </span>
          </summary>
          <div className="px-5 pb-5 text-sm text-fg-muted">{f.a}</div>
        </details>
      ))}
    </div>
  );
}

/** The closing call to action at the bottom of a page. */
export function Cta({ title, lead }: { title: ReactNode; lead: ReactNode }) {
  return (
    <section className="border-t border-line py-20 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 text-center sm:px-6">
        <p className="font-mono text-2xl font-bold tracking-tight text-fg sm:text-3xl">{title}</p>
        <p className="mx-auto mt-4 max-w-xl text-md text-fg-muted">{lead}</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link href="/docs/getting-started" className={primary}>
            Get started
          </Link>
          <Link href="/docs/deploy-cloud" className={secondary}>
            Deploy on a free server
          </Link>
          <a href="https://github.com/Ivan825/brio_" className={secondary}>
            Source on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
