import type { ReactNode } from "react";

/** A numbered section: mono label, a large heading, a short lead, then its content. */
export function Section({
  id,
  index,
  label,
  title,
  lead,
  children,
}: {
  id: string;
  index: string;
  label: string;
  title: ReactNode;
  lead?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="border-t border-line py-20 sm:py-28" aria-labelledby={`${id}-title`}>
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <p className="font-mono text-xs uppercase tracking-[0.08em] text-fg-subtle">
          <span className="text-accent">{index}</span> · {label}
        </p>
        <h2
          id={`${id}-title`}
          className="mt-3 max-w-3xl font-mono text-2xl font-bold tracking-tight text-fg sm:text-3xl"
        >
          {title}
        </h2>
        {lead ? <p className="mt-4 max-w-2xl text-md text-fg-muted">{lead}</p> : null}
        <div className="mt-10">{children}</div>
      </div>
    </section>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`font-mono font-bold text-fg ${className}`}>
      brio
      <span className="brio-cursor" aria-hidden />
    </span>
  );
}
