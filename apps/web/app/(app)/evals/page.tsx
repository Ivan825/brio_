import type { Metadata } from "next";
import { Chip } from "@/components/chip";
import { EmptyState } from "@/components/empty-state";
import { serverApi } from "@/lib/server-api";

export const metadata: Metadata = { title: "Evals" };

interface Summary {
  strategy: string;
  missions: number;
  passed: number;
  passRate: number;
  costUsd: number;
  minutes: number;
  attempts: number;
  costAdjusted: number;
}

interface Verdict {
  bestSingle: string | null;
  liftPoints: number | null;
  costRatio: number | null;
  met: boolean | null;
  routerGainPct: number | null;
  routerMet: boolean | null;
}

interface RunSummary {
  id: string;
  mode: "offline" | "live";
  createdAt: string;
  startedAt: string;
  finishedAt: string;
  missions: number;
  summaries: Summary[];
  verdict: Verdict;
  notes: string | null;
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

function VerdictLine({ v }: { v: Verdict }) {
  return (
    <div className="flex flex-wrap gap-2" data-testid="eval-verdict">
      {v.liftPoints === null ? (
        <Chip>vs best single agent: not measured</Chip>
      ) : (
        <Chip tone={v.met ? "success" : "warning"} title="PRD target: ≥ 15 points at ≤ 1.3× the cost">
          vs {v.bestSingle}: {v.liftPoints >= 0 ? "+" : ""}
          {v.liftPoints} pts at {v.costRatio}× cost · {v.met ? "target met" : "target not met"}
        </Chip>
      )}
      {v.routerGainPct !== null && (
        <Chip tone={v.routerMet ? "success" : "warning"} title="PRD target: ≥ 10% after 200 missions">
          learned vs static: {v.routerGainPct >= 0 ? "+" : ""}
          {v.routerGainPct}% pass rate per $
        </Chip>
      )}
    </div>
  );
}

export default async function Page() {
  const { status, data } = await serverApi<{ runs: RunSummary[] }>("/v1/evals/runs");
  const runs = status === 200 && data ? data.runs : [];
  if (!runs.length)
    return (
      <EmptyState
        label="evals"
        command="pnpm evals --save-db $DATABASE_URL --workspace <id>"
        title="No eval runs yet"
      >
        The golden missions run under every routing strategy — each agent alone, static routing and Brio's
        learned router — and a hidden scorer checks what each produced. Save a run here to compare them.
      </EmptyState>
    );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-8">
      <header className="flex flex-col gap-2">
        <p className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">evals</p>
        <h1 className="text-xl font-semibold tracking-tight">Golden-mission evals</h1>
        <p className="max-w-3xl text-fg-muted">
          Each run puts every golden mission through each routing strategy and scores the result with hidden
          checks. Brio's target: a pass rate at least 15 points above the best single agent, at no more than
          1.3× its cost.
        </p>
      </header>
      {runs.map((run) => (
        <section
          key={run.id}
          className="flex flex-col gap-3"
          data-testid="eval-run"
          aria-label={`Run ${when(run.startedAt)}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-mono text-sm text-fg">{when(run.startedAt)} UTC</h2>
            <Chip tone={run.mode === "live" ? "info" : "muted"}>{run.mode}</Chip>
            <Chip>{run.missions} missions</Chip>
          </div>
          <VerdictLine v={run.verdict} />
          <div className="overflow-x-auto rounded-md border border-line">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-surface font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
                <tr>
                  <th className="px-3 py-2 text-left font-normal">Strategy</th>
                  <th className="px-3 py-2 text-right font-normal">Pass rate</th>
                  <th className="px-3 py-2 text-right font-normal">Passed</th>
                  <th className="px-3 py-2 text-right font-normal">Cost / mission</th>
                  <th className="px-3 py-2 text-right font-normal">Minutes</th>
                  <th className="px-3 py-2 text-right font-normal">Attempts</th>
                  <th className="px-3 py-2 text-right font-normal">Pass rate per $</th>
                </tr>
              </thead>
              <tbody>
                {[...run.summaries]
                  .sort((a, b) => b.passRate - a.passRate || a.costUsd - b.costUsd)
                  .map((s) => (
                    <tr key={s.strategy} className="border-t border-line" data-testid="eval-row">
                      <td className="px-3 py-2 font-mono">{s.strategy}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{pct(s.passRate)}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">
                        {s.passed}/{s.missions}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">${s.costUsd.toFixed(4)}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{s.minutes}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{s.attempts}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{s.costAdjusted}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {run.notes && <p className="text-fg-muted">{run.notes}</p>}
        </section>
      ))}
    </div>
  );
}
