// `brio board`: the live board in a terminal. The mission's tasks, who is on them and what they cost, what waits for
// you, and the latest events — redrawn as events arrive over SSE, until the mission ends.
import type { BrioClient, SseEvent } from "./client";

export interface BoardMission {
  mission: {
    id: string;
    title: string;
    status: string;
    blockedReason: string | null;
    budget?: { usd?: number };
  };
  plan: { version: number; status: string } | null;
  tasks: Array<{
    key: string;
    title: string;
    status: string;
    planVersion: number;
    attempts: Array<{ agentId: string; status: string; costUsd: number; role: string }>;
  }>;
  deliveries?: Array<{ kind: string; status: string; url: string | null; branch: string }>;
}

export interface BoardEvent {
  seq: number;
  type: string;
  ts: string;
  payload: Record<string, unknown>;
}

export const ENDED = new Set(["done", "failed", "cancelled"]);

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};
type Tone = keyof typeof ANSI;

const STATUS_TONE: Record<string, Tone> = {
  done: "green",
  failed: "red",
  cancelled: "dim",
  blocked: "yellow",
  awaiting_approval: "yellow",
  running: "cyan",
  verifying: "magenta",
  revise: "yellow",
  pending: "dim",
  ready: "dim",
  planning: "cyan",
};

const usd = (n: number) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

/** One line per event, as the web board summarises them. */
export function eventLine(e: BoardEvent): string {
  const p = e.payload;
  const bits: string[] = [];
  for (const k of [
    "taskKey",
    "agent",
    "kind",
    "verdict",
    "decision",
    "what",
    "reason",
    "branch",
    "url",
    "error",
  ]) {
    const v = p[k];
    if (typeof v === "string" && v) bits.push(v.length > 60 ? `${v.slice(0, 59)}…` : v);
    else if (k === "agent" && v && typeof v === "object" && "name" in v)
      bits.push(String((v as { name: unknown }).name));
  }
  if (typeof p.usd === "number") bits.push(usd(p.usd));
  return `${String(e.seq).padStart(4)} ${e.type}${bits.length ? ` · ${bits.join(" · ")}` : ""}`;
}

/** The board as text; colours only when asked (a TTY without NO_COLOR). */
export function renderBoard(
  m: BoardMission,
  events: BoardEvent[],
  o: { color: boolean; width: number; agents?: Map<string, string>; maxEvents?: number },
): string {
  const c = (tone: Tone, s: string) => (o.color ? `${ANSI[tone]}${s}${ANSI.reset}` : s);
  const w = Math.max(60, o.width);
  const work = m.tasks.filter((t) => t.planVersion > 0);
  const cost = m.tasks.reduce((n, t) => n + t.attempts.reduce((x, a) => x + a.costUsd, 0), 0);
  const lines: string[] = [];
  lines.push(
    `${c("bold", m.mission.title)}  ${c(STATUS_TONE[m.mission.status] ?? "dim", m.mission.status)}  ${c("dim", `${usd(cost)}${m.mission.budget?.usd ? ` of ${usd(m.mission.budget.usd)}` : ""}`)}`,
  );
  if (m.mission.blockedReason) lines.push(c("yellow", `  ${m.mission.blockedReason}`));
  if (m.plan?.status === "proposed" && m.mission.status === "awaiting_approval")
    lines.push(
      c("yellow", `  plan v${m.plan.version} waits for approval: brio approve ${m.mission.id.slice(0, 8)}`),
    );
  for (const d of m.deliveries ?? [])
    if (d.status === "awaiting_approval")
      lines.push(
        c(
          "yellow",
          `  ${d.kind === "pull_request" ? "pull request" : "branch"} ${d.branch} waits for approval`,
        ),
      );
    else if (d.status === "done" && d.url) lines.push(c("green", `  pull request: ${d.url}`));
  lines.push("");
  const keyW = Math.min(28, Math.max(8, ...work.map((t) => t.key.length)) + 1);
  const titleW = Math.max(12, w - keyW - 12 - 18 - 10);
  lines.push(
    c("dim", `${pad("task", keyW)} ${pad("status", 12)} ${pad("agent", 18)} ${pad("title", titleW)} cost`),
  );
  for (const t of work.length ? work : m.tasks) {
    const maker = [...t.attempts].reverse().find((a) => a.role === "maker") ?? t.attempts.at(-1);
    const agent = maker ? (o.agents?.get(maker.agentId) ?? maker.agentId.slice(0, 8)) : "–";
    const spent = t.attempts.reduce((n, a) => n + a.costUsd, 0);
    lines.push(
      `${pad(t.key, keyW)} ${c(STATUS_TONE[t.status] ?? "dim", pad(t.status, 12))} ${pad(agent, 18)} ${pad(t.title, titleW)} ${spent ? usd(spent) : ""}`,
    );
  }
  lines.push("");
  const recent = events.slice(-(o.maxEvents ?? 12));
  for (const e of recent) lines.push(c("dim", eventLine(e).slice(0, w)));
  return `${lines.join("\n")}\n`;
}

const STRUCTURAL =
  /^(plan|task|mission|message|review|judge|approval|check|merge|delivery|lease)\.|^attempt\.(queued|started|finished|cost)$/;

/**
 * Follows a mission: renders now, then redraws as events arrive (in place on a TTY, as appended lines otherwise).
 * Resolves with the final status once the mission ends, or when `once` is set after the first draw.
 */
export async function followBoard(
  client: BrioClient,
  missionId: string,
  io: { write: (s: string) => void; tty: boolean; color: boolean; width: () => number },
  o: { once?: boolean; signal?: AbortSignal } = {},
): Promise<string> {
  const agents = new Map<string, string>();
  const loadAgents = async () => {
    const { agents: list } = await client.get<{ agents: Array<{ id: string; name: string }> }>("/v1/agents");
    for (const a of list) agents.set(a.id, a.name);
  };
  await loadAgents().catch(() => {});
  let m = await client.get<BoardMission>(`/v1/missions/${missionId}`);
  const events: BoardEvent[] = [];
  const draw = () => {
    const text = renderBoard(m, events, { color: io.color, width: io.width(), agents });
    io.write(io.tty ? `\x1b[H\x1b[2J${text}` : text);
  };
  draw();
  if (o.once || ENDED.has(m.mission.status)) return m.mission.status;
  let refresh: Promise<void> | null = null;
  await client.events(
    missionId,
    async (e: SseEvent) => {
      const ev = e.data as BoardEvent;
      events.push(ev);
      if (!io.tty) io.write(`${eventLine(ev)}\n`);
      if (STRUCTURAL.test(ev.type)) {
        refresh ??= client
          .get<BoardMission>(`/v1/missions/${missionId}`)
          .then((next) => {
            m = next;
          })
          .finally(() => {
            refresh = null;
          });
        await refresh;
      }
      if (io.tty) draw();
      return ENDED.has(m.mission.status) || undefined;
    },
    { ...(o.signal ? { signal: o.signal } : {}) },
  );
  if (!io.tty) io.write(renderBoard(m, [], { color: false, width: io.width(), agents, maxEvents: 0 }));
  return m.mission.status;
}
