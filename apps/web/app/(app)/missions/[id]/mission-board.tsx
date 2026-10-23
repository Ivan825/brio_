"use client";

import { EVENT_TYPES } from "@brio/schema";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRunning } from "@/components/running";
import { RUNNING_STATUSES, StatusChip } from "@/components/status-chip";
import { usd } from "@/lib/format";
import type { AgentSummary, AttemptSummary } from "@/lib/types";
import { type Delivery, DeliveryPanel } from "./delivery-panel";
import { MessagesPanel, type MissionMessage } from "./messages-panel";
import { PlanGraph } from "./plan-graph";
import { PlanPanel, type PlanView } from "./plan-panel";
import { SaveTemplate } from "./save-template";
import { TaskList } from "./task-list";

export interface MissionDetail {
  mission: {
    id: string;
    title: string;
    goal: string;
    status: string;
    lastEventSeq: number;
    blockedReason: string | null;
    autoApprove: boolean;
    routing: { strategy: string };
    inputs?: {
      issue: { url: string; title: string } | null;
      files: { name: string; size: number; text: boolean }[];
    };
    createdAt: string;
  };
  plan: PlanView | null;
  tasks: MissionTask[];
  deliveries: Delivery[];
}

export interface MissionTask {
  id: string;
  key: string;
  type: string;
  title: string;
  status: string;
  mode: string;
  planVersion: number;
  dependsOn: string[];
  blockedReason: string | null;
  revisions: number;
  pinnedAgentId: string | null;
  sensitivity: string;
  /** How the router staffed the task and why (null until it is dispatched). */
  route: {
    mode: string;
    agents: { agentId: string; role: string }[];
    rationale: string;
    degraded: string | null;
  } | null;
  /** The attempt a multi-agent mode chose. */
  result: { attemptId: string; note: string } | null;
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

/** Events that change the mission's shape (plan, task states, messages): the page re-reads its data on them. */
const STRUCTURAL =
  /^(plan|task|mission|message|review|judge|approval|check|handoff|contract|lease|delivery)\.|^attempt\.(queued|started|finished)$/;

function summarise(e: BoardEvent): string {
  const p = e.payload;
  switch (e.type) {
    case "mission.created":
      return String(p.title ?? "");
    case "mission.blocked":
      return String(p.reason ?? "");
    case "plan.proposed":
    case "plan.edited": {
      const lint = p.lint as { errors?: number; fixes?: number } | undefined;
      return `v${p.version} · ${(p.tasks as unknown[] | undefined)?.length ?? 0} task(s)${lint?.errors ? ` · ${lint.errors} error(s)` : ""}${lint?.fixes ? ` · ${lint.fixes} fix(es)` : ""}`;
    }
    case "plan.approved":
      return `v${p.version} · ${p.tasks} task(s)`;
    case "mission.failed":
    case "plan.failed":
      return String(p.reason ?? (p.errors as string[] | undefined)?.join("; ") ?? "");
    case "task.ready":
    case "task.done":
      return String(p.taskKey ?? "") + (p.agent ? ` · ${p.agent} · ${usd(p.costUsd as number)}` : "");
    case "task.routed":
      return `${p.taskKey} · ${String(p.mode ?? "").replaceAll("_", " ")} · ${p.rationale ?? ""}${p.degraded ? ` · ${p.degraded}` : ""}`;
    case "judge.verdict":
      return `${p.taskKey} · winner ${p.winner ?? "unreadable"}${p.reasons ? ` · ${p.reasons}` : ""}`;
    case "task.blocked":
    case "task.failed":
      return `${p.taskKey} · ${p.reason ?? (p.reasons as string[] | undefined)?.join("; ") ?? ""}`;
    case "lease.granted":
    case "lease.released":
      return `${p.taskKey} · ${(p.resources as string[] | undefined)?.join(", ") ?? ""}`;
    case "handoff.created":
      return `${p.from} → ${p.to}`;
    case "message.sent":
      return `${p.from} → ${p.to} (${p.kind}): ${String(p.body ?? "")}`;
    case "message.answered":
      return `${p.from}: ${String(p.body ?? "")}`;
    case "check.result":
      return `${p.kind} ${p.passed === null ? "in progress" : p.passed ? "passed" : "failed"}${p.summary ? ` · ${p.summary}` : ""}`;
    case "review.verdict":
      return `${p.taskKey} · ${p.verdict}${(p.reasons as string[] | undefined)?.length ? ` · ${(p.reasons as string[]).join("; ")}` : ""}`;
    case "approval.requested":
      return `${p.taskKey ? `${p.taskKey} · ` : ""}${p.what}${p.branch ? ` · ${p.branch}` : ""}`;
    case "approval.decided":
      return `${String(p.action ?? "").replaceAll("_", " ")} · ${p.decision}${p.reason ? ` · ${p.reason}` : ""}`;
    case "delivery.started":
      return `${p.branch} · ${String(p.commit ?? "").slice(0, 12)}`;
    case "delivery.done":
      return p.url ? `${p.branch} · ${p.url}` : String(p.branch ?? "");
    case "delivery.failed":
      return String(p.error ?? "");
    case "contract.changed":
      return `${p.name} v${p.from} → v${p.to}`;
    case "attempt.queued":
    case "attempt.started": {
      const agent = p.agent as { name?: string; model?: string } | undefined;
      const sandbox = p.sandbox as { profile?: string } | null | undefined;
      const why = p.rationale ? ` · ${p.rationale}` : "";
      return `${agent?.name ?? "agent"} → ${p.taskKey ?? "task"} · ${agent?.model ?? ""}${sandbox?.profile ? ` · sandbox ${sandbox.profile}` : ""}${why}`;
    }
    case "attempt.file_edit":
      return `${p.op} ${p.path}`;
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
    case "mission.done":
      return `${usd(p.costUsd as number)} · ${p.attempts} attempt(s) · ${p.minutes} min`;
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

/** The live board for one mission: plan, tasks, messages and the event stream over SSE (resuming by Last-Event-ID). */
export function MissionBoard({
  initial,
  agents,
  messages,
}: {
  initial: MissionDetail;
  agents: AgentSummary[];
  messages: MissionMessage[];
}) {
  const router = useRouter();
  const [graph, setGraph] = useState(false);
  const { mission, plan, tasks } = initial;
  const [events, setEvents] = useState<BoardEvent[]>([]);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [opens, setOpens] = useState(0);
  const lastSeq = useRef(0);
  const refresh = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Events up to here are already in the server-rendered data; later ones mean the page should re-read it.
  const rendered = useRef(initial.mission.lastEventSeq);
  rendered.current = initial.mission.lastEventSeq;
  const { setRunning } = useRunning();

  useEffect(() => {
    // EventSource reconnects by itself and sends Last-Event-ID; the API resumes from there with no gaps.
    const source = new EventSource(`/v1/missions/${mission.id}/events`);
    const onEvent = (msg: MessageEvent<string>) => {
      const e = JSON.parse(msg.data) as BoardEvent;
      if (e.seq <= lastSeq.current) return; // never render a duplicate
      lastSeq.current = e.seq;
      setEvents((prev) => [...prev, e]);
      if (STRUCTURAL.test(e.type) && e.seq > rendered.current) {
        if (refresh.current) clearTimeout(refresh.current);
        refresh.current = setTimeout(() => router.refresh(), 250);
      }
    };
    source.onopen = () => {
      setConnection("live");
      setOpens((n) => n + 1);
    };
    source.onerror = () => setConnection("reconnecting");
    source.onmessage = onEvent;
    for (const t of EVENT_TYPES) source.addEventListener(t, onEvent as EventListener);
    return () => {
      source.close();
      if (refresh.current) clearTimeout(refresh.current);
    };
  }, [mission.id, router]);

  const working = useMemo(
    () =>
      RUNNING_STATUSES.has(mission.status) ||
      tasks.some((t) => t.attempts.some((a) => a.status === "running" || a.status === "queued")),
    [mission.status, tasks],
  );
  useEffect(() => {
    setRunning(`mission:${mission.id}`, working);
    return () => setRunning(`mission:${mission.id}`, false);
  }, [mission.id, working, setRunning]);

  const liveCost = (attemptId: string) => {
    let total: number | null = null;
    for (const e of events)
      if (e.attemptId === attemptId && e.type === "attempt.cost") total = e.payload.totalUsd as number;
    return total;
  };
  const planning = tasks.filter((t) => t.planVersion === 0);
  const work = tasks.filter((t) => t.planVersion > 0);
  const openForUser = messages.filter((m) => m.to === "user" && m.status === "open");

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-2">
        <p className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
          mission · {mission.id.slice(0, 8)} ·{" "}
          <Link href={`/missions/${mission.id}/report`} className="text-focus hover:underline">
            report
          </Link>
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{mission.title}</h1>
          <StatusChip status={mission.status} />
          {plan && (
            <span className="ml-auto">
              <SaveTemplate missionId={mission.id} title={mission.title} />
            </span>
          )}
        </div>
        <p className="max-w-3xl text-fg-muted">{mission.goal}</p>
        {(mission.inputs?.issue || (mission.inputs?.files.length ?? 0) > 0) && (
          <p className="flex flex-wrap items-center gap-2 text-xs text-fg-muted" data-testid="mission-inputs">
            {mission.inputs?.issue && (
              <a
                href={mission.inputs.issue.url}
                className="text-focus hover:underline"
                target="_blank"
                rel="noreferrer"
              >
                issue: {mission.inputs.issue.title}
              </a>
            )}
            {mission.inputs?.files.map((f) => (
              <span key={f.name} className="font-mono">
                {f.name}
              </span>
            ))}
          </p>
        )}
        {mission.blockedReason && (
          <p
            className="rounded-md border border-line bg-surface px-3 py-2 font-mono text-xs text-warning"
            data-testid="mission-blocked"
          >
            {mission.blockedReason}
            {/no agents|connector/.test(mission.blockedReason) && (
              <>
                {" · "}
                <Link href="/connectors" className="text-focus hover:underline">
                  add a connector
                </Link>
              </>
            )}
          </p>
        )}
      </header>

      {plan && plan.status === "proposed" && mission.status === "awaiting_approval" && (
        <PlanPanel missionId={mission.id} plan={plan} agents={agents} />
      )}
      {openForUser.length > 0 && <MessagesPanel messages={openForUser} />}
      <DeliveryPanel
        missionId={mission.id}
        deliveries={initial.deliveries ?? []}
        missionDone={mission.status === "done"}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <section aria-labelledby="tasks-title" className="flex min-w-0 flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 id="tasks-title" className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
              {work.length ? `Tasks · plan v${work[0]?.planVersion}` : "Planning"}
            </h2>
            {work.length > 1 && (
              <button
                type="button"
                className="font-mono text-2xs text-fg-muted hover:text-fg"
                aria-pressed={graph}
                onClick={() => setGraph(!graph)}
              >
                {graph ? "list" : "graph"}
              </button>
            )}
          </div>
          {graph && work.length > 1 && (
            <PlanGraph
              label="Task graph"
              tasks={work.map((t) => ({
                key: t.key,
                type: t.type,
                title: t.title,
                dependsOn: t.dependsOn,
                status: t.status,
              }))}
            />
          )}
          <TaskList tasks={work.length ? work : planning} agents={agents} liveCost={liveCost} />
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
            className="max-h-[70vh] overflow-auto rounded-md border border-line bg-surface font-mono text-xs tabular-nums"
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
                <span className="min-w-0 truncate text-fg-muted" title={summarise(e)}>
                  {summarise(e)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
