import type { Metadata } from "next";
import { Chip } from "@/components/chip";
import { EmptyState } from "@/components/empty-state";
import { usd } from "@/lib/format";
import { serverApi } from "@/lib/server-api";
import { Filters } from "./filters";
import { type Sharing, SharingToggles } from "./sharing";

export const metadata: Metadata = { title: "Scoreboard" };

interface ScoreRow {
  agentKey: string;
  vendor: string;
  model: string;
  agents: string[];
  taskType: string;
  passRate: number;
  elo: number;
  avgCostUsd: number;
  latencyS: number;
  n: number;
  updatedAt: string;
  trend: { at: string; passRate: number; elo: number }[];
}

interface Board {
  taskTypes: string[];
  vendors: string[];
  rows: ScoreRow[];
}

interface GlobalRow {
  agentKey: string;
  taskType: string;
  passRate: number;
  elo: number;
  avgCostUsd: number;
  latencyS: number;
  n: number;
}

/** Pass rate over the last updates, as a small line (0–100%). */
function Trend({ points }: { points: ScoreRow["trend"] }) {
  if (points.length < 2) return <span className="text-fg-subtle">–</span>;
  const w = 96;
  const h = 24;
  const step = w / (points.length - 1);
  const line = points.map((p, i) => `${(i * step).toFixed(1)},${(h - p.passRate * h).toFixed(1)}`).join(" ");
  const first = points[0]?.passRate ?? 0;
  const last = points.at(-1)?.passRate ?? 0;
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={`pass rate ${Math.round(first * 100)}% to ${Math.round(last * 100)}%`}
      className={last >= first ? "text-success" : "text-warning"}
      data-testid="trend"
    >
      <polyline points={line} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ taskType?: string; vendor?: string }>;
}) {
  const { taskType, vendor } = await searchParams;
  const query = new URLSearchParams();
  if (taskType) query.set("taskType", taskType);
  if (vendor) query.set("vendor", vendor);
  const { status, data } = await serverApi<Board>(`/v1/scoreboard${query.size ? `?${query}` : ""}`);
  // No workspace yet (or no access): the board is simply empty.
  const board = status === 200 && data ? data : { taskTypes: [], vendors: [], rows: [] };
  const [sharing, global] = await Promise.all([
    serverApi<{ sharing: Sharing }>("/v1/scoreboard/sharing"),
    serverApi<{ rows: GlobalRow[] }>(
      `/v1/scoreboard/global${taskType ? `?taskType=${encodeURIComponent(taskType)}` : ""}`,
    ),
  ]);
  const shared = sharing.status === 200 && sharing.data ? sharing.data.sharing : null;
  const globalRows = global.status === 200 && global.data ? global.data.rows : [];
  const globalPanel = shared && (
    <section className="flex flex-col gap-3" aria-label="global scoreboard">
      <SharingToggles initial={shared} />
      {globalRows.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-line" data-testid="global-scores">
          <table className="w-full min-w-[600px] text-sm">
            <thead className="bg-surface font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
              <tr>
                <th className="px-3 py-2 text-left font-normal">Across workspaces</th>
                <th className="px-3 py-2 text-left font-normal">Task type</th>
                <th className="px-3 py-2 text-right font-normal">Pass rate</th>
                <th className="px-3 py-2 text-right font-normal">Elo</th>
                <th className="px-3 py-2 text-right font-normal">Avg cost</th>
                <th className="px-3 py-2 text-right font-normal">n</th>
              </tr>
            </thead>
            <tbody>
              {globalRows.map((r) => (
                <tr key={`${r.taskType}:${r.agentKey}`} className="border-t border-line">
                  <td className="px-3 py-2">
                    <Chip>{r.agentKey}</Chip>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{r.taskType}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{pct(r.passRate)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{r.elo}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{usd(r.avgCostUsd)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{r.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );

  if (board.taskTypes.length === 0)
    return (
      <div className="flex flex-col gap-6">
        <EmptyState
          label="scoreboard"
          command="brio scores --task-type code.feature"
          title="Nothing to score yet"
        >
          Every verdict updates which agent wins at which task type, at what cost and how fast. Run a few
          missions and the scoreboard fills in.
        </EmptyState>
        {globalPanel && <div className="mx-auto w-full max-w-6xl px-6 pb-8">{globalPanel}</div>}
      </div>
    );

  const byType = new Map<string, ScoreRow[]>();
  for (const r of board.rows) byType.set(r.taskType, [...(byType.get(r.taskType) ?? []), r]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-2">
        <p className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">scoreboard</p>
        <h1 className="text-xl font-semibold tracking-tight">Who wins at what</h1>
        <p className="max-w-3xl text-fg-muted">
          Pass rate is the share of attempts that passed their checks (a revision counts half), decayed with a
          60-day half-life. Elo comes from judges comparing results head to head. The router samples from
          these to pick agents, weighed against cost and speed by each mission's priority.
        </p>
      </header>
      <Filters taskTypes={board.taskTypes} vendors={board.vendors} taskType={taskType} vendor={vendor} />
      {board.rows.length === 0 ? (
        <p className="text-fg-muted">No scores match these filters.</p>
      ) : (
        [...byType.entries()].map(([type, rows]) => (
          <section key={type} className="flex flex-col gap-2" aria-label={type} data-testid="score-type">
            <h2 className="font-mono text-sm text-fg">{type}</h2>
            <div className="overflow-x-auto rounded-md border border-line">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-surface font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
                  <tr>
                    <th className="px-3 py-2 text-left font-normal">Agent</th>
                    <th className="px-3 py-2 text-right font-normal">Pass rate</th>
                    <th className="px-3 py-2 text-right font-normal">Elo</th>
                    <th className="px-3 py-2 text-right font-normal">Avg cost</th>
                    <th className="px-3 py-2 text-right font-normal">p50 time</th>
                    <th className="px-3 py-2 text-right font-normal">n</th>
                    <th className="px-3 py-2 text-left font-normal">Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.agentKey} className="border-t border-line" data-testid="score-row">
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-fg">{r.agents.length ? r.agents.join(", ") : r.model}</span>
                          <Chip>{r.agentKey}</Chip>
                          {i === 0 && rows.length > 1 && <Chip tone="success">leading</Chip>}
                          {r.n < 2 && <Chip tone="info">learning</Chip>}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{pct(r.passRate)}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{r.elo}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{usd(r.avgCostUsd)}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">
                        {r.latencyS ? `${Math.round(r.latencyS)}s` : "–"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{r.n}</td>
                      <td className="px-3 py-2">
                        <Trend points={r.trend} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
      {globalPanel}
    </div>
  );
}
