// A routing simulation (BUILD_PLAN M4 acceptance): synthetic agents with known pass rates, costs and latencies take
// tasks chosen by the router; outcomes are drawn from the true rates and fed back to the scoreboard. Pure and seeded.

import { type Rng, seeded } from "../score/random";
import { applyOutcome, freshScore, type Score } from "../score/score";
import { type Candidate, LAMBDAS, type Priority, routeLearned } from "./learned";
import type { RouteAgent } from "./static";

export interface SyntheticAgent {
  id: string;
  vendor: string;
  passRate: number;
  costUsd: number;
  latencyS: number;
}

export interface SimulationResult {
  /** The agent chosen for each task, in order. */
  picks: string[];
  /** The agent with the highest true utility. */
  best: string;
  scores: Record<string, Score>;
}

/** The true utility the router is trying to find (same weights as routing, with the true pass rate). */
export function trueUtility(agents: SyntheticAgent[], priority: Priority): Record<string, number> {
  const l = LAMBDAS[priority];
  const span = (xs: number[]) => {
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    return (x: number) => (hi > lo ? (x - lo) / (hi - lo) : 0);
  };
  const nc = span(agents.map((a) => a.costUsd));
  const nl = span(agents.map((a) => a.latencyS));
  return Object.fromEntries(
    agents.map((a) => [a.id, a.passRate - l.cost * nc(a.costUsd) - l.time * nl(a.latencyS)]),
  );
}

export function simulate(
  agents: SyntheticAgent[],
  o: { tasks: number; priority: Priority; seed: number; taskType?: string },
): SimulationResult {
  const rng: Rng = seeded(o.seed);
  const outcomes: Rng = seeded(o.seed ^ 0x9e3779b9);
  const type = o.taskType ?? "code.feature";
  const t0 = new Date("2026-10-23T00:00:00Z");
  const scores: Record<string, Score> = Object.fromEntries(agents.map((a) => [a.id, freshScore(t0)]));
  const routeAgent = (a: SyntheticAgent): RouteAgent => ({
    id: a.id,
    name: a.id,
    model: a.id,
    route: "api",
    vendor: a.vendor,
    taskTypes: [type],
    local: false,
    runnable: true,
  });
  const picks: string[] = [];
  for (let i = 0; i < o.tasks; i++) {
    const now = new Date(t0.getTime() + i * 60_000);
    const cands: Candidate[] = agents.map((a) => ({
      agent: routeAgent(a),
      score: scores[a.id] as Score,
      healthy: true,
      estUsd: a.costUsd,
    }));
    const d = routeLearned(
      {
        key: `t${i}`,
        type,
        sensitivity: "internal",
        pinnedAgentId: null,
        mode: "single",
        hasTests: true,
        modeExplicit: true,
      },
      cands,
      { priority: o.priority, rng, everyone: cands },
    );
    if (!d.ok) throw new Error(d.reason);
    const id = d.agents[0]?.agentId as string;
    picks.push(id);
    const a = agents.find((x) => x.id === id) as SyntheticAgent;
    const passed = outcomes() < a.passRate;
    scores[id] = applyOutcome(scores[id] as Score, {
      outcome: passed ? "pass" : "fail",
      costUsd: a.costUsd,
      seconds: a.latencyS,
      now,
    });
  }
  const u = trueUtility(agents, o.priority);
  const best = Object.entries(u).sort((x, y) => y[1] - x[1])[0]?.[0] as string;
  return { picks, best, scores };
}
