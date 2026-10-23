import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Chip } from "@/components/chip";
import { serverApi } from "@/lib/server-api";

export const metadata: Metadata = { title: "Mission report" };
export const dynamic = "force-dynamic";

interface ReportCheck {
  kind: string;
  hard: boolean;
  status: string;
  summary?: string;
}
interface Report {
  title: string;
  goal: string;
  status: string;
  costUsd: number;
  budgetUsd: number | null;
  minutes: number;
  attempts: number;
  tasks: Array<{
    key: string;
    title: string;
    type: string;
    status: string;
    agent: string | null;
    vendor: string | null;
    mode: string;
    rationale: string | null;
    revisions: number;
    reroutes: number;
    carried: boolean;
    costUsd: number;
    seconds: number;
    checks: ReportCheck[];
    blockedReason: string | null;
  }>;
  agents: Array<{ agent: string; vendor: string; attempts: number; passed: number; costUsd: number }>;
  integration: {
    status: string;
    branch: string | null;
    commit: string | null;
    round: number;
    checks: Array<{ command: string; passed: boolean }>;
  } | null;
  openIssues: Array<{ kind: string; task?: string; text: string }>;
  replans: number;
}

const money = (n: number) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
const TONE = {
  passed: "success",
  failed: "danger",
  needs_human: "warning",
  pending: "muted",
  running: "info",
} as const;

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { status, data } = await serverApi<{ report: Report; final: boolean }>(`/v1/missions/${id}/report`);
  if (status === 404 || !data) notFound();
  const r = data.report;
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-8" data-testid="mission-report">
      <header className="flex flex-col gap-2">
        <p className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
          {data.final ? "final report" : "live report"} ·{" "}
          <Link href={`/missions/${id}`} className="text-focus hover:underline">
            back to the board
          </Link>{" "}
          ·{" "}
          <a href={`/v1/missions/${id}/report?format=md`} className="text-focus hover:underline">
            Markdown
          </a>
        </p>
        <h1 className="text-xl font-semibold tracking-tight">{r.title}</h1>
        <p className="text-sm text-fg-muted">{r.goal}</p>
        <div className="flex flex-wrap gap-2">
          <Chip tone={r.status === "done" ? "success" : r.status === "failed" ? "danger" : "info"}>
            {r.status}
          </Chip>
          <Chip>
            {money(r.costUsd)}
            {r.budgetUsd ? ` of ${money(r.budgetUsd)}` : ""}
          </Chip>
          <Chip>{r.minutes} min</Chip>
          <Chip>{r.attempts} attempts</Chip>
          {r.replans > 0 && <Chip tone="warning">{r.replans} replan</Chip>}
        </div>
      </header>

      <section aria-labelledby="tasks" className="flex flex-col gap-3">
        <h2 id="tasks" className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
          What was done
        </h2>
        <ul className="flex flex-col gap-2">
          {r.tasks.map((t) => (
            <li
              key={t.key}
              className="flex flex-col gap-1.5 rounded-md border border-line bg-surface p-3"
              data-testid="report-task"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">{t.key}</span>
                <span className="text-sm">{t.title}</span>
                <Chip tone={t.status === "done" ? "success" : t.status === "failed" ? "danger" : "muted"}>
                  {t.status}
                </Chip>
                {t.carried && <Chip>carried over</Chip>}
                <span className="ml-auto font-mono text-2xs text-fg-subtle">
                  {t.agent ? `${t.agent} · ${t.vendor}` : "no agent"} · {t.mode} · {money(t.costUsd)} ·{" "}
                  {Math.round(t.seconds)}s
                </span>
              </div>
              {t.rationale && <p className="text-xs text-fg-muted">{t.rationale}</p>}
              <div className="flex flex-wrap gap-1">
                {t.checks.map((c) => (
                  <Chip
                    key={`${c.kind}:${c.summary ?? ""}`}
                    tone={TONE[c.status as keyof typeof TONE] ?? "muted"}
                    title={c.summary}
                  >
                    {c.kind}
                    {c.hard ? "" : " (soft)"}: {c.status}
                  </Chip>
                ))}
                {t.revisions > 0 && (
                  <Chip tone="warning">
                    {t.revisions} revision{t.revisions > 1 ? "s" : ""}
                  </Chip>
                )}
                {t.reroutes > 0 && <Chip tone="warning">rerouted</Chip>}
              </div>
              {t.blockedReason && <p className="text-xs text-danger">{t.blockedReason}</p>}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="agents" className="flex flex-col gap-3">
        <h2 id="agents" className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
          Who did it
        </h2>
        <table className="w-full text-left text-sm">
          <thead className="font-mono text-2xs text-fg-muted">
            <tr>
              <th className="py-1">Agent</th>
              <th>Vendor</th>
              <th>Attempts</th>
              <th>Passed</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {r.agents.map((a) => (
              <tr key={a.agent} className="border-t border-line">
                <td className="py-1.5">{a.agent}</td>
                <td className="font-mono text-xs">{a.vendor}</td>
                <td>{a.attempts}</td>
                <td>{a.passed}</td>
                <td className="font-mono text-xs">{money(a.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {r.integration && (
        <section aria-labelledby="integration" className="flex flex-col gap-2">
          <h2 id="integration" className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
            Integration
          </h2>
          <p className="text-sm">
            <Chip tone={r.integration.status === "passed" ? "success" : "warning"}>
              {r.integration.status}
            </Chip>{" "}
            {r.integration.branch && <span className="font-mono text-xs">{r.integration.branch}</span>} ·
            round {r.integration.round}
          </p>
          <ul className="text-xs text-fg-muted">
            {r.integration.checks.map((c) => (
              <li key={c.command} className="font-mono">
                {c.passed ? "✓" : "✗"} {c.command}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="open" className="flex flex-col gap-2">
        <h2 id="open" className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
          Still open
        </h2>
        {r.openIssues.length === 0 ? (
          <p className="text-sm text-fg-muted">Nothing.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {r.openIssues.map((o) => (
              <li key={`${o.kind}:${o.task ?? ""}:${o.text}`}>
                <Chip tone="warning">{o.kind.replaceAll("_", " ")}</Chip>{" "}
                {o.task ? <span className="font-mono text-xs">{o.task}: </span> : null}
                {o.text}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
