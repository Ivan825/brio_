"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { Button } from "@/components/button";
import { Chip } from "@/components/chip";
import { FormError, Label, Select } from "@/components/field";
import { StatusChip } from "@/components/status-chip";
import { api } from "@/lib/api";
import { usd } from "@/lib/format";
import type { AgentSummary, AttemptSummary } from "@/lib/types";
import type { MissionTask } from "./mission-board";

/** Manual runs are for tasks the scheduler is not handling right now: blocked or failed ones, and plan reviews. */

/** The scheduler runs everything else; a person steps in for blocked and failed tasks. */
const RUNNABLE = new Set(["failed", "blocked"]);

function Diff({ attempt }: { attempt: AttemptSummary }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (text !== null)
    return (
      <pre
        className="mt-2 max-h-96 overflow-auto rounded-md border border-line bg-bg p-2 text-xs leading-relaxed"
        data-testid="attempt-diff"
      >
        {text.split("\n").map((line, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
            key={i}
            className={
              line.startsWith("+") && !line.startsWith("+++")
                ? "text-success"
                : line.startsWith("-") && !line.startsWith("---")
                  ? "text-danger"
                  : line.startsWith("@@")
                    ? "text-info"
                    : "text-fg-muted"
            }
          >
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
    );
  return (
    <div className="mt-1">
      <Button
        size="sm"
        variant="ghost"
        onClick={async () => {
          try {
            const { artifacts } = await api<{ artifacts: { id: string; kind: string }[] }>(
              `/v1/attempts/${attempt.id}/artifacts`,
            );
            const diff = artifacts.find((a) => a.kind === "diff");
            if (!diff) throw new Error("no changes");
            const res = await fetch(`/v1/artifacts/${diff.id}/content`, { credentials: "same-origin" });
            if (!res.ok) throw new Error(`failed (${res.status})`);
            setText(await res.text());
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        Show diff
      </Button>
      <FormError>{error}</FormError>
    </div>
  );
}

function Answer({ attempt }: { attempt: AttemptSummary }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (text !== null)
    return (
      <pre
        className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-bg p-2 text-xs leading-relaxed"
        data-testid="attempt-output"
      >
        {text}
      </pre>
    );
  return (
    <div className="mt-1">
      <Button
        size="sm"
        variant="ghost"
        onClick={async () => {
          try {
            const res = await fetch(`/v1/attempts/${attempt.id}/output`, { credentials: "same-origin" });
            if (!res.ok) throw new Error(res.status === 404 ? "no output" : `failed (${res.status})`);
            setText(await res.text());
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        Show answer
      </Button>
      <FormError>{error}</FormError>
    </div>
  );
}

/** Thumbs up or down on a result: it moves the agent's score on this task type (once per person). */
function Rate({ attempt }: { attempt: AttemptSummary }) {
  const [rated, setRated] = useState<1 | -1 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rate = async (rating: 1 | -1) => {
    setError(null);
    try {
      await api(`/v1/attempts/${attempt.id}/rating`, { method: "POST", body: { rating } });
      setRated(rating);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (rated !== null)
    return (
      <span className="mt-1 self-center text-fg-subtle" data-testid="rated">
        rated {rated > 0 ? "up" : "down"}
      </span>
    );
  return (
    <div className="mt-1 flex items-center gap-1">
      <Button size="sm" variant="ghost" aria-label="Rate up" onClick={() => rate(1)}>
        +1
      </Button>
      <Button size="sm" variant="ghost" aria-label="Rate down" onClick={() => rate(-1)}>
        −1
      </Button>
      <FormError>{error}</FormError>
    </div>
  );
}

/** Results people rate: made, revised and merged work (not reviews or judgements). */
const RATABLE = new Set(["make", "revise", "merge"]);

/** Run a task now with a chosen agent (M1 direct run), and follow its attempts. */
export function TaskRunner({
  task,
  agents,
  liveCost,
}: {
  task: MissionTask;
  agents: AgentSummary[];
  liveCost: (attemptId: string) => number | null;
}) {
  const id = useId();
  const runnable = agents.filter((a) => a.runnable);
  const [agentId, setAgentId] = useState(task.pinnedAgentId ?? runnable[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = task.attempts.find((a) => a.status === "running" || a.status === "queued");

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/tasks/${task.id}/attempts`, { method: "POST", body: { agentId } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function cancel(attemptId: string) {
    setError(null);
    try {
      await api(`/v1/attempts/${attemptId}/cancel`, { method: "POST" });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const agentName = (aid: string) => agents.find((a) => a.id === aid)?.name ?? "agent";

  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
      {runnable.length === 0 ? (
        <p className="font-mono text-2xs text-fg-subtle">
          no runnable agents ·{" "}
          <Link href="/agents" className="text-focus hover:underline">
            build one
          </Link>
        </p>
      ) : (
        <div className="flex items-end gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Label htmlFor={`${id}-agent`}>Agent</Label>
            <Select id={`${id}-agent`} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              {runnable.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.model}
                </option>
              ))}
            </Select>
          </div>
          {running ? (
            <Button size="md" onClick={() => cancel(running.id)}>
              Cancel
            </Button>
          ) : (
            <Button variant="primary" onClick={run} disabled={busy || !agentId || !RUNNABLE.has(task.status)}>
              {busy ? "Starting…" : "Run now"}
            </Button>
          )}
        </div>
      )}
      <FormError>{error}</FormError>
      {task.attempts.length > 0 && (
        <ol className="flex flex-col gap-1.5" aria-label="Attempts">
          {task.attempts.map((a) => {
            const cost = a.status === "running" || a.status === "queued" ? liveCost(a.id) : a.costUsd;
            return (
              <li key={a.id} className="font-mono text-2xs" data-testid="attempt" data-status={a.status}>
                <div className="flex flex-wrap items-center gap-2 text-fg-muted">
                  <span className="text-fg">{agentName(a.agentId)}</span>
                  {a.purpose && <Chip>{a.purpose}</Chip>}
                  {task.result?.attemptId === a.id && <Chip tone="success">chosen</Chip>}
                  <StatusChip status={a.status} />
                  <span className="tabular-nums" data-testid="attempt-cost">
                    {usd(cost ?? 0)}
                  </span>
                  {a.status !== "running" && (
                    <span className="tabular-nums">
                      {a.tokensIn} in · {a.tokensOut} out
                    </span>
                  )}
                </div>
                {a.exitReason && a.status !== "succeeded" && (
                  <p className="mt-0.5 truncate text-danger" title={a.exitReason}>
                    {a.exitReason}
                  </p>
                )}
                {a.status === "succeeded" && (
                  <div className="flex flex-wrap gap-2">
                    <Answer attempt={a} />
                    <Diff attempt={a} />
                    {(a.purpose === null || RATABLE.has(a.purpose)) && <Rate attempt={a} />}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
