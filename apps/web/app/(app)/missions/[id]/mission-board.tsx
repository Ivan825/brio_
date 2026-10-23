"use client";

import { agentColorVar } from "@brio/brand";
import { EVENT_TYPES } from "@brio/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRunning } from "@/components/running";
import { RUNNING_STATUSES, StatusChip } from "@/components/status-chip";
import { usd } from "@/lib/format";
import type { AgentSummary, AttemptSummary } from "@/lib/types";
import { TaskRunner } from "./task-runner";

export interface MissionDetail {
  mission: {
    id: string;
    title: string;
    goal: string;
    status: string;
    lastEventSeq: number;
    createdAt: string;
  };
  plan: { version: number; status: string } | null;
  tasks: MissionTask[];
}

export interface MissionTask {
  id: string;
  key: string;
  type: string;
  title: string;
  status: string;
  mode: string;
  pinnedAgentId: string | null;
  sensitivity: string;
  attempts: AttemptSummary[];
}

export interface BoardEvent {
  seq: number;
  taskId: string | null;
  attemptId: string | null;
  type: string;
  actor: string;
  ts: string;
  payload: Record<string, unknown>;
}

type Connection = "connecting" | "live" | "reconnecting";

const STATUS_FROM_EVENT: Record<string, string> = {
  "plan.proposed": "awaiting_approval",
  "mission.done": "done",
  "mission.failed": "failed",
};

function summarise(e: BoardEvent): string {
  const p = e.payload;
  switch (e.type) {
    case "mission.created":
      return String(p.title ?? "");
    case "plan.proposed":
      return `v${p.version} · ${(p.tasks as unknown[] | undefined)?.length ?? 0} task(s) · ${p.planner ?? ""}`;
    case "mission.failed":
      return String(p.reason ?? "");
    case "attempt.started": {
      const agent = p.agent as { name?: string; model?: string } | undefined;
      return `${agent?.name ?? "agent"} → ${p.taskKey ?? "task"} · ${agent?.model ?? ""}`;
    }
    case "attempt.message":
      return `${p.role}: ${String(p.text ?? "").replace(/\s+/g, " ")}`;
    case "attempt.tool_call":
      return `${p.name}(${JSON.stringify(p.args ?? {})})`;
    case "attempt.cost":
      return `${usd(p.usd as number)} · ${p.tokensIn} in · ${p.tokensOut} out · total ${usd(p.totalUsd as number)}`;
    case "attempt.finished": {
      const u = p.usage as { usd?: number; seconds?: number } | undefined;
      return `${p.status} · ${usd(u?.usd)} · ${u?.seconds ?? 0}s${p.status === "succeeded" ? "" : ` · ${p.exitReason ?? ""}`}`;
    }
    default:
      return Object.keys(p).length ? JSON.stringify(p) : "";
  }
}

const time = (ts: string) =>
  new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

/** The live board for one mission: tasks plus the event stream over SSE, resuming by Last-Event-ID. */
export function MissionBoard({ initial, agents }: { initial: MissionDetail; agents: AgentSummary[] }) {
  const { mission } = initial;
  const [tasks, setTasks] = useState(initial.tasks);
  const [events, setEvents] = useState<BoardEvent[]>([]);
  const [activeAttempts, setActiveAttempts] = useState<Set<string>>(
    () =>
      new Set(
        initial.tasks.flatMap((t) => t.attempts.filter((a) => a.status === "running").map((a) => a.id)),
      ),
  );
  const [status, setStatus] = useState(mission.status);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [opens, setOpens] = useState(0);
  const lastSeq = useRef(0);
  const { setRunning } = useRunning();

  const applyAttemptEvent = useCallback((e: BoardEvent) => {
    const attemptId = e.attemptId;
    if (!attemptId || !e.taskId) return;
    const started = e.type === "attempt.started";
    setActiveAttempts((prev) => {
      const next = new Set(prev);
      if (started) next.add(attemptId);
      else next.delete(attemptId);
      return next;
    });
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id !== e.taskId) return t;
        const p = e.payload;
        const usage = p.usage as { usd?: number; tokensIn?: number; tokensOut?: number } | undefined;
        const others = t.attempts.filter((a) => a.id !== attemptId);
        const existing = t.attempts.find((a) => a.id === attemptId);
        const attempt: AttemptSummary = {
          id: attemptId,
          taskId: t.id,
          agentId: (p.agent as { id?: string } | undefined)?.id ?? existing?.agentId ?? "",
          role: "maker",
          status: started ? "running" : String(p.status),
          startedAt: existing?.startedAt ?? e.ts,
          endedAt: started ? null : e.ts,
          costUsd: usage?.usd ?? existing?.costUsd ?? 0,
          tokensIn: usage?.tokensIn ?? existing?.tokensIn ?? 0,
          tokensOut: usage?.tokensOut ?? existing?.tokensOut ?? 0,
          exitReason: started ? null : String(p.exitReason ?? ""),
        };
        const status = started ? "running" : p.status === "succeeded" ? "verifying" : "failed";
        return { ...t, status, attempts: [attempt, ...others] };
      }),
    );
  }, []);

  useEffect(() => {
    // EventSource reconnects by itself and sends Last-Event-ID; the API resumes from there with no gaps.
    const source = new EventSource(`/v1/missions/${mission.id}/events`);
    const onEvent = (msg: MessageEvent<string>) => {
      const e = JSON.parse(msg.data) as BoardEvent;
      if (e.seq <= lastSeq.current) return; // never render a duplicate
      lastSeq.current = e.seq;
      setEvents((prev) => [...prev, e]);
      const next = STATUS_FROM_EVENT[e.type];
      if (next) setStatus(next);
      if (e.type === "attempt.started" || e.type === "attempt.finished") applyAttemptEvent(e);
    };
    source.onopen = () => {
      setConnection("live");
      setOpens((n) => n + 1);
    };
    source.onerror = () => setConnection("reconnecting");
    source.onmessage = onEvent;
    for (const t of EVENT_TYPES) source.addEventListener(t, onEvent as EventListener);
    return () => source.close();
  }, [mission.id, applyAttemptEvent]);

  useEffect(() => {
    setRunning(`mission:${mission.id}`, RUNNING_STATUSES.has(status) || activeAttempts.size > 0);
    return () => setRunning(`mission:${mission.id}`, false);
  }, [mission.id, status, activeAttempts, setRunning]);

  const liveCost = (attemptId: string) => {
    let total: number | null = null;
    for (const e of events)
      if (e.attemptId === attemptId && e.type === "attempt.cost") total = e.payload.totalUsd as number;
    return total;
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-2">
        <p className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
          mission · {mission.id.slice(0, 8)}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{mission.title}</h1>
          <StatusChip status={status} />
        </div>
        <p className="max-w-3xl text-fg-muted">{mission.goal}</p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <section aria-labelledby="tasks-title" className="flex flex-col gap-3">
          <h2 id="tasks-title" className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
            Tasks
          </h2>
          {tasks.length === 0 ? (
            <p className="text-fg-muted">No tasks yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {tasks.map((t, i) => (
                <li
                  key={t.id}
                  className="rounded-md border border-line bg-surface p-3"
                  style={{ borderLeft: `2px solid ${agentColorVar(i)}` }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs text-fg-muted">{t.key}</span>
                    <StatusChip status={t.status} />
                  </div>
                  <p className="mt-1.5">{t.title}</p>
                  <p className="mt-1 font-mono text-2xs text-fg-subtle">
                    {t.type} · {t.mode}
                  </p>
                  <TaskRunner task={t} agents={agents} liveCost={liveCost} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="events-title" className="flex min-w-0 flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 id="events-title" className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
              Events
            </h2>
            <span
              className="font-mono text-2xs text-fg-subtle"
              data-testid="connection"
              data-state={connection}
              data-opens={opens}
            >
              {connection === "live" ? "● live" : connection}
            </span>
          </div>
          <ol
            className="overflow-hidden rounded-md border border-line bg-surface font-mono text-xs tabular-nums"
            aria-label="Event stream"
            data-testid="event-stream"
          >
            {events.length === 0 && <li className="px-3 py-2 text-fg-subtle">waiting for events…</li>}
            {events.map((e) => (
              <li
                key={e.seq}
                className="flex gap-3 border-b border-line px-3 py-1.5 last:border-b-0"
                data-seq={e.seq}
                data-type={e.type}
              >
                <span className="w-6 shrink-0 text-right text-fg-subtle">{e.seq}</span>
                <span className="hidden shrink-0 text-fg-subtle sm:inline">{time(e.ts)}</span>
                <span className="shrink-0 text-fg">{e.type}</span>
                <span className="min-w-0 truncate text-fg-muted">{summarise(e)}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
