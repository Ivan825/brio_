import type { ReactNode } from "react";

interface EmptyStateProps {
  /** Section label, shown as a mono uppercase eyebrow. */
  label: string;
  /** The `$` command line that would do this from the CLI. */
  command: string;
  title: string;
  children: ReactNode;
  /** Milestone that brings this screen to life, shown while it is still empty by design. */
  milestone?: string;
  action?: ReactNode;
}

export function EmptyState({ label, command, title, children, milestone, action }: EmptyStateProps) {
  return (
    <section
      className="mx-auto flex max-w-xl flex-col gap-4 px-6 py-16 md:py-24"
      aria-labelledby="empty-title"
    >
      <p className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">{label}</p>
      <h1 id="empty-title" className="text-xl font-semibold tracking-tight text-fg">
        {title}
      </h1>
      <div className="text-base text-fg-muted">{children}</div>
      <pre className="overflow-x-auto rounded-md border border-line bg-surface px-3 py-2.5 font-mono text-sm text-fg">
        <span className="select-none text-fg-subtle">$ </span>
        {command}
        <span className="brio-cursor ml-0.5" data-state="idle" aria-hidden="true" />
      </pre>
      {(action || milestone) && (
        <div className="flex items-center gap-3">
          {action}
          {milestone && (
            <span className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-2xs text-fg-subtle">
              arrives in {milestone}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
