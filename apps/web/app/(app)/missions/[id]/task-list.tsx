"use client";

import { agentColorVar } from "@brio/brand";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { FormError, Textarea } from "@/components/field";
import { StatusChip } from "@/components/status-chip";
import { api } from "@/lib/api";
import type { AgentSummary } from "@/lib/types";
import type { MissionTask } from "./mission-board";
import { TaskRunner } from "./task-runner";

/** A person's verdict on a task waiting for review. */
function Review({ task }: { task: MissionTask }) {
  const router = useRouter();
  const [reasons, setReasons] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (verdict: "pass" | "revise" | "fail") => {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/tasks/${task.id}/review`, { method: "POST", body: { verdict, reasons } });
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3" data-testid="review">
      <p className="font-mono text-2xs uppercase tracking-[0.08em] text-warning">Waiting for your review</p>
      <Textarea
        aria-label="Review notes"
        placeholder="What to change (for send back)"
        value={reasons}
        onChange={(e) => setReasons(e.target.value)}
        className="min-h-14"
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => send("pass")}>
          Accept
        </Button>
        <Button size="sm" disabled={busy || !reasons.trim()} onClick={() => send("revise")}>
          Send back
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => send("fail")}>
          Fail task
        </Button>
      </div>
      <FormError>{error}</FormError>
    </div>
  );
}

export function TaskList({
  tasks,
  agents,
  liveCost,
}: {
  tasks: MissionTask[];
  agents: AgentSummary[];
  liveCost: (attemptId: string) => number | null;
}) {
  if (tasks.length === 0) return <p className="text-fg-muted">No tasks yet.</p>;
  const keyOf = new Map(tasks.map((t) => [t.id, t.key]));
  return (
    <ul className="flex flex-col gap-2">
      {tasks.map((t, i) => {
        const latest = t.attempts[0];
        const agentIndex = Math.max(
          0,
          agents.findIndex((a) => a.id === latest?.agentId),
        );
        const waitingForPerson = t.status === "verifying" && latest?.status === "succeeded";
        return (
          <li
            key={t.id}
            className="rounded-md border border-line bg-surface p-3"
            style={{ borderLeft: `2px solid ${agentColorVar(latest ? agentIndex : i)}` }}
            data-testid="task"
            data-key={t.key}
            data-status={t.status}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-xs text-fg-muted">{t.key}</span>
              <StatusChip status={t.status} />
            </div>
            <p className="mt-1.5">{t.title}</p>
            <p className="mt-1 font-mono text-2xs text-fg-subtle">
              {t.type} · {t.mode}
              {t.dependsOn.length ? ` · after ${t.dependsOn.map((d) => keyOf.get(d) ?? "?").join(", ")}` : ""}
              {t.revisions ? ` · revision ${t.revisions}` : ""}
            </p>
            {t.blockedReason && (
              <p className="mt-1 font-mono text-2xs text-warning">
                {t.blockedReason.replace(/^lease:\s*/, "")}
              </p>
            )}
            {waitingForPerson && <Review task={t} />}
            <TaskRunner task={t} agents={agents} liveCost={liveCost} />
          </li>
        );
      })}
    </ul>
  );
}
