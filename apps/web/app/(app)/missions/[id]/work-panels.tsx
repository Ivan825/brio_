"use client";

import { useState } from "react";
import { Button } from "@/components/button";
import { Chip } from "@/components/chip";
import { DiffView } from "@/components/diff-view";
import { FormError } from "@/components/field";
import { usd } from "@/lib/format";
import type { AgentSummary } from "@/lib/types";
import type { MissionTask } from "./mission-board";

export interface MissionLease {
  id: string;
  taskId: string;
  taskKey: string | null;
  resourceKind: string;
  resource: string;
  mode: string;
  expiresAt: string;
  releasedAt: string | null;
  createdAt: string;
}

export interface MissionIntegration {
  id: string;
  round: number;
  status: string;
  branch: string | null;
  commit: string | null;
  diffArtifactId: string | null;
  conflicts: { between: [string, string]; files: string[] }[];
  checks: { command: string; passed: boolean; exitCode: number | null }[];
}

const heading = "font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted";

/** Where the money went: the mission against its budget, by agent and by task. */
export function CostPanel({
  tasks,
  agents,
  budgetUsd,
  liveCost,
}: {
  tasks: MissionTask[];
  agents: AgentSummary[];
  budgetUsd?: number;
  /** Cost streamed for a running attempt, before its row is final. */
  liveCost: (attemptId: string) => number | null;
}) {
  const attempts = tasks.flatMap((t) => t.attempts.map((a) => ({ ...a, taskKey: t.key })));
  const costOf = (a: (typeof attempts)[number]) => Math.max(a.costUsd, liveCost(a.id) ?? 0);
  const total = attempts.reduce((n, a) => n + costOf(a), 0);
  const byAgent = new Map<string, number>();
  for (const a of attempts) byAgent.set(a.agentId, (byAgent.get(a.agentId) ?? 0) + costOf(a));
  const byTask = tasks
    .map((t) => ({
      key: t.key,
      usd: attempts.filter((a) => a.taskKey === t.key).reduce((n, a) => n + costOf(a), 0),
    }))
    .filter((t) => t.usd > 0)
    .sort((a, b) => b.usd - a.usd);
  const share = budgetUsd ? Math.min(1, total / budgetUsd) : null;
  return (
    <section aria-labelledby="cost-title" className="flex flex-col gap-2" data-testid="cost-panel">
      <h2 id="cost-title" className={heading}>
        Cost
      </h2>
      <p className="font-mono text-sm tabular-nums">
        {usd(total)}
        {budgetUsd ? <span className="text-fg-muted"> of {usd(budgetUsd)}</span> : null}
      </p>
      {share !== null && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2" aria-hidden>
          <div
            className={
              share > 0.9 ? "h-full bg-danger" : share > 0.7 ? "h-full bg-warning" : "h-full bg-success"
            }
            style={{ width: `${share * 100}%` }}
          />
        </div>
      )}
      {byAgent.size > 0 && (
        <ul className="flex flex-col gap-0.5 font-mono text-xs">
          {[...byAgent.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([id, v]) => (
              <li key={id} className="flex justify-between gap-2">
                <span className="truncate">{agents.find((a) => a.id === id)?.name ?? id.slice(0, 8)}</span>
                <span className="tabular-nums text-fg-muted">{usd(v)}</span>
              </li>
            ))}
        </ul>
      )}
      {byTask.length > 1 && (
        <details className="text-xs">
          <summary className="cursor-pointer font-mono text-2xs text-fg-muted">by task</summary>
          <ul className="mt-1 flex flex-col gap-0.5 font-mono">
            {byTask.map((t) => (
              <li key={t.key} className="flex justify-between gap-2">
                <span className="truncate">{t.key}</span>
                <span className="tabular-nums text-fg-muted">{usd(t.usd)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** Who holds which files and resources (PRD F18): held now first, then released. */
export function LeasesPanel({ leases }: { leases: MissionLease[] }) {
  const held = leases.filter((l) => !l.releasedAt);
  const released = leases.filter((l) => l.releasedAt);
  return (
    <section aria-labelledby="leases-title" className="flex flex-col gap-2" data-testid="leases-panel">
      <h2 id="leases-title" className={heading}>
        Leases
      </h2>
      {!leases.length && <p className="text-xs text-fg-subtle">No task has claimed files or resources.</p>}
      <ul className="flex flex-col gap-1 font-mono text-xs">
        {held.map((l) => (
          <li key={l.id} className="flex flex-wrap items-center gap-1.5" data-testid="lease" data-held="true">
            <Chip tone="running">{l.mode}</Chip>
            <span className="truncate">{l.resource}</span>
            <span className="text-fg-subtle">· {l.taskKey}</span>
          </li>
        ))}
      </ul>
      {released.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer font-mono text-2xs text-fg-muted">
            {released.length} released
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5 font-mono text-fg-muted">
            {released.map((l) => (
              <li key={l.id} data-testid="lease" data-held="false">
                {l.resource} · {l.taskKey}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** The mission's work merged together: its checks, conflicts and the merged diff. */
export function IntegrationPanel({ integration: i }: { integration: MissionIntegration | null }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!i) return null;
  const tone =
    i.status === "passed"
      ? "success"
      : i.status === "running" || i.status === "queued"
        ? "running"
        : "warning";
  return (
    <section aria-labelledby="merge-title" className="flex flex-col gap-2" data-testid="integration-panel">
      <h2 id="merge-title" className={heading}>
        Merged result
      </h2>
      <p className="flex flex-wrap items-center gap-2 text-xs">
        <Chip tone={tone}>{i.status}</Chip>
        <span className="font-mono text-fg-muted">round {i.round}</span>
        {i.branch && <span className="truncate font-mono">{i.branch}</span>}
      </p>
      {i.conflicts.map((c) => (
        <p key={c.between.join("+")} className="font-mono text-xs text-warning">
          {c.between.join(" × ")}: {c.files.join(", ")}
        </p>
      ))}
      {i.checks.length > 0 && (
        <ul className="font-mono text-xs">
          {i.checks.map((c) => (
            <li key={c.command} className={c.passed ? "text-success" : "text-danger"}>
              {c.passed ? "✓" : "✗"} {c.command}
            </li>
          ))}
        </ul>
      )}
      {i.diffArtifactId && diff === null && (
        <div>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              try {
                const res = await fetch(`/v1/artifacts/${i.diffArtifactId}/content`, {
                  credentials: "same-origin",
                });
                if (!res.ok) throw new Error(`failed (${res.status})`);
                setDiff(await res.text());
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Show merged diff
          </Button>
        </div>
      )}
      {diff !== null && <DiffView text={diff} testId="merged-diff" />}
      <FormError>{error}</FormError>
    </section>
  );
}
