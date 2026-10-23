"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { Button } from "@/components/button";
import { FormError, Label, Select } from "@/components/field";
import { StatusChip } from "@/components/status-chip";
import { api } from "@/lib/api";
import { usd } from "@/lib/format";
import type { AgentSummary, AttemptSummary } from "@/lib/types";
import type { MissionTask } from "./mission-board";

const RUNNABLE = new Set(["pending", "ready", "failed", "verifying", "revise", "blocked"]);

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
  const running = task.attempts.find((a) => a.status === "running");

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
              {busy ? "Starting…" : "Run task"}
            </Button>
          )}
        </div>
      )}
      <FormError>{error}</FormError>
      {task.attempts.length > 0 && (
        <ol className="flex flex-col gap-1.5" aria-label="Attempts">
          {task.attempts.map((a) => {
            const cost = a.status === "running" ? liveCost(a.id) : a.costUsd;
            return (
              <li key={a.id} className="font-mono text-2xs" data-testid="attempt" data-status={a.status}>
                <div className="flex flex-wrap items-center gap-2 text-fg-muted">
                  <span className="text-fg">{agentName(a.agentId)}</span>
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
                {a.status === "succeeded" && <Answer attempt={a} />}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
