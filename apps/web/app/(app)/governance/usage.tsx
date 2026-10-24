import Link from "next/link";
import { usd } from "@/lib/format";

export interface UsageView {
  from: string;
  to: string;
  totals: {
    costUsd: number;
    attempts: number;
    succeeded: number;
    failed: number;
    tokensIn: number;
    tokensOut: number;
    missionsDone: number;
    missionsFailed: number;
  };
  byDay: Array<{ day: string; costUsd: number; attempts: number }>;
  byAgent: Array<{
    agentId: string;
    name: string;
    model: string;
    costUsd: number;
    attempts: number;
    succeeded: number;
  }>;
  byVendor: Array<{ connector: string; costUsd: number; attempts: number }>;
  byTaskType: Array<{ taskType: string; costUsd: number; attempts: number; succeeded: number }>;
}

const heading = "font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted";
const PERIODS = [7, 30, 90] as const;
const count = (n: number) => new Intl.NumberFormat("en", { notation: "compact" }).format(n);
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "–");

/** Spend per day as bars, every day of the period shown (days without work are empty). */
function DailySpend({ view, days }: { view: UsageView; days: number }) {
  const by = new Map(view.byDay.map((d) => [d.day, d]));
  const end = new Date(view.to);
  const series = Array.from({ length: days }, (_, i) => {
    const day = new Date(end.getTime() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    return { day, costUsd: by.get(day)?.costUsd ?? 0, attempts: by.get(day)?.attempts ?? 0 };
  });
  const top = Math.max(...series.map((s) => s.costUsd), 0.000001);
  return (
    <figure className="flex flex-col gap-1">
      <div className="flex h-24 items-end gap-px" role="img" aria-label={`Spend per day over ${days} days`}>
        {series.map((s) => (
          <div
            key={s.day}
            title={`${s.day}: ${usd(s.costUsd)}, ${s.attempts} attempts`}
            className="min-h-px flex-1 rounded-t-xs bg-accent opacity-80 hover:opacity-100"
            style={{
              height: `${Math.max(1, (s.costUsd / top) * 100)}%`,
              ...(s.costUsd ? {} : { opacity: 0.25 }),
            }}
          />
        ))}
      </div>
      <figcaption className="flex justify-between font-mono text-2xs text-fg-subtle">
        <span>{series[0]?.day}</span>
        <span>{series.at(-1)?.day}</span>
      </figcaption>
    </figure>
  );
}

function Breakdown({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ label: string; detail?: string; costUsd: number; attempts: number; ok?: number }>;
}) {
  if (!rows.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <p className={heading}>{title}</p>
      <ul className="divide-y divide-line rounded-md border border-line text-sm">
        {rows.map((r) => (
          <li key={r.label} className="flex flex-col gap-0.5 px-3 py-1.5">
            <div className="flex items-baseline gap-3">
              <span className="min-w-0 flex-1 truncate">
                {r.label}
                {r.detail && <span className="ml-2 font-mono text-2xs text-fg-subtle">{r.detail}</span>}
              </span>
              <span className="shrink-0 font-mono text-xs tabular-nums">{usd(r.costUsd)}</span>
            </div>
            <span className="font-mono text-2xs tabular-nums text-fg-muted">
              {r.attempts} runs{r.ok !== undefined ? ` · ${pct(r.ok, r.attempts)} passed` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the workspace spent and ran (GET /v1/usage). */
export function Usage({ view, days }: { view: UsageView; days: number }) {
  const t = view.totals;
  return (
    <section aria-labelledby="usage-title" className="flex flex-col gap-4" data-testid="usage">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="usage-title" className={heading}>
          Usage
        </h2>
        <nav aria-label="Period" className="ml-auto flex gap-1">
          {PERIODS.map((p) => (
            <Link
              key={p}
              href={`/governance?days=${p}`}
              aria-current={p === days ? "page" : undefined}
              className={`rounded-sm px-2 py-0.5 font-mono text-2xs ${p === days ? "bg-surface-2 text-fg" : "text-fg-muted hover:text-fg"}`}
            >
              {p} days
            </Link>
          ))}
        </nav>
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Spent", usd(t.costUsd)],
          ["Attempts", t.attempts ? `${t.attempts} · ${pct(t.succeeded, t.attempts)} passed` : "0"],
          ["Missions", `${t.missionsDone} done · ${t.missionsFailed} failed`],
          ["Tokens", `${count(t.tokensIn)} in · ${count(t.tokensOut)} out`],
        ].map(([k, v]) => (
          <div key={k} className="rounded-md border border-line bg-surface px-3 py-2">
            <dt className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-subtle">{k}</dt>
            <dd className="mt-0.5 font-mono text-sm tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      {t.attempts ? (
        <>
          <DailySpend view={view} days={days} />
          <div className="grid gap-4 md:grid-cols-3">
            <Breakdown
              title="By agent"
              rows={view.byAgent.map((a) => ({
                label: a.name,
                detail: a.model,
                costUsd: a.costUsd,
                attempts: a.attempts,
                ok: a.succeeded,
              }))}
            />
            <Breakdown
              title="By vendor"
              rows={view.byVendor.map((v) => ({
                label: v.connector,
                costUsd: v.costUsd,
                attempts: v.attempts,
              }))}
            />
            <Breakdown
              title="By kind of task"
              rows={view.byTaskType.map((x) => ({
                label: x.taskType,
                costUsd: x.costUsd,
                attempts: x.attempts,
                ok: x.succeeded,
              }))}
            />
          </div>
        </>
      ) : (
        <p className="text-sm text-fg-muted">Nothing ran in this period.</p>
      )}
    </section>
  );
}
