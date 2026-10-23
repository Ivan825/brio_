// Eval summaries (PRD §7): per strategy, pass rate, cost, time and attempts per mission; then the PRD's verdicts —
// Brio (learned) against the best single agent (≥ 15 points at ≤ 1.3× its cost), and learned against static routing
// (≥ 10% better cost-adjusted pass rate). Pure.
import type { EvalMissionResult, EvalStrategySummary, EvalVerdict } from "@brio/schema";

export const PRD_TARGETS = { liftPoints: 15, costRatio: 1.3, routerGainPct: 10 } as const;

/** A floor for cost so a free run does not divide by zero (a tenth of a cent). */
const COST_FLOOR = 0.001;
const round = (n: number, places = 4) => Math.round(n * 10 ** places) / 10 ** places;

export function summarise(results: readonly EvalMissionResult[]): EvalStrategySummary[] {
  const by = new Map<string, EvalMissionResult[]>();
  for (const r of results) by.set(r.strategy, [...(by.get(r.strategy) ?? []), r]);
  return [...by.entries()].map(([strategy, rs]) => {
    const n = rs.length;
    const passed = rs.filter((r) => r.passed).length;
    const costUsd = rs.reduce((s, r) => s + r.costUsd, 0) / n;
    const passRate = passed / n;
    return {
      strategy,
      missions: n,
      passed,
      passRate: round(passRate),
      costUsd: round(costUsd, 6),
      minutes: round(rs.reduce((s, r) => s + r.minutes, 0) / n, 2),
      attempts: round(rs.reduce((s, r) => s + r.attempts, 0) / n, 2),
      costAdjusted: round(passRate / Math.max(costUsd, COST_FLOOR)),
    };
  });
}

export function evalVerdict(summaries: readonly EvalStrategySummary[]): EvalVerdict {
  const learned = summaries.find((s) => s.strategy === "learned");
  const staticRun = summaries.find((s) => s.strategy === "static");
  const singles = summaries
    .filter((s) => s.strategy.startsWith("single:"))
    .sort((a, b) => b.passRate - a.passRate || a.costUsd - b.costUsd);
  const best = singles[0];
  const liftPoints = learned && best ? round((learned.passRate - best.passRate) * 100, 1) : null;
  const costRatio = learned && best ? round(learned.costUsd / Math.max(best.costUsd, COST_FLOOR), 2) : null;
  const routerGainPct =
    learned && staticRun && staticRun.costAdjusted > 0
      ? round(((learned.costAdjusted - staticRun.costAdjusted) / staticRun.costAdjusted) * 100, 1)
      : null;
  return {
    bestSingle: best?.strategy ?? null,
    liftPoints,
    costRatio,
    met:
      liftPoints === null || costRatio === null
        ? null
        : liftPoints >= PRD_TARGETS.liftPoints && costRatio <= PRD_TARGETS.costRatio,
    routerGainPct,
    routerMet: routerGainPct === null ? null : routerGainPct >= PRD_TARGETS.routerGainPct,
  };
}

/** The comparable metrics table, as Markdown. */
export function renderEvalTable(summaries: readonly EvalStrategySummary[], v: EvalVerdict): string {
  const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
  const lines = [
    "| Strategy | Missions | Passed | Pass rate | Cost / mission | Minutes / mission | Attempts / mission | Pass rate per $ |",
    "|---|---|---|---|---|---|---|---|",
    ...[...summaries]
      .sort((a, b) => b.passRate - a.passRate || a.costUsd - b.costUsd)
      .map(
        (s) =>
          `| ${s.strategy} | ${s.missions} | ${s.passed} | ${pct(s.passRate)} | $${s.costUsd.toFixed(4)} | ${s.minutes} | ${s.attempts} | ${s.costAdjusted} |`,
      ),
    "",
    v.liftPoints === null
      ? "Brio vs the best single agent: not measured (run learned and at least one single agent)."
      : `Brio (learned) vs the best single agent (${v.bestSingle}): ${v.liftPoints >= 0 ? "+" : ""}${v.liftPoints} points at ${v.costRatio}× the cost — target ≥ ${PRD_TARGETS.liftPoints} points at ≤ ${PRD_TARGETS.costRatio}×: ${v.met ? "met" : "not met"}.`,
    v.routerGainPct === null
      ? "Learned vs static routing: not measured."
      : `Learned vs static routing, cost-adjusted pass rate: ${v.routerGainPct >= 0 ? "+" : ""}${v.routerGainPct}% — target ≥ ${PRD_TARGETS.routerGainPct}% (after 200 missions): ${v.routerMet ? "met" : "not met"}.`,
  ];
  return `${lines.join("\n")}\n`;
}
