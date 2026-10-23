// The router (ROUTING_AND_QUALITY §3): filter candidates, Thompson-sample each one's quality, weigh it against cost and
// latency by the mission's priority, choose the execution mode, pick agents for its roles (different vendors where it
// can), and say why in one line. Pure: the scores, the randomness and the estimates come in.

import { type Rng, sampleBeta } from "../score/random";
import { passRate, type Score } from "../score/score";
import { eligibleAgents, type RouteAgent, type RouteTask } from "./static";

export type Priority = "quality" | "balanced" | "cheap" | "fast";
export type Mode = "single" | "best_of_n" | "ensemble" | "maker_checker" | "debate" | "cascade" | "pipeline";
export type Role = "maker" | "candidate" | "checker" | "judge" | "merger";

/** λ weights per priority (ROUTING §3.1). */
export const LAMBDAS: Record<Priority, { elo: number; cost: number; time: number }> = {
  quality: { elo: 0.1, cost: 0.05, time: 0.05 },
  balanced: { elo: 0.1, cost: 0.2, time: 0.1 },
  cheap: { elo: 0.05, cost: 0.5, time: 0.05 },
  fast: { elo: 0.05, cost: 0.1, time: 0.5 },
};

export interface Candidate {
  agent: RouteAgent;
  score: Score;
  /** False when the connector's last health check failed. */
  healthy: boolean;
  estUsd: number;
}

export interface LearnedTask extends RouteTask {
  /** The task has command checks (tests, typecheck, build) that can decide between candidates. */
  hasTests: boolean;
  /** Set when the plan or a person chose the mode; otherwise the default rules choose. */
  modeExplicit: boolean;
  modeParams?: { n?: number; steps?: Array<{ agentId: string }> };
}

export interface Assignment {
  agentId: string;
  role: Role;
}

export type LearnedDecision =
  | {
      ok: true;
      mode: Mode;
      agents: Assignment[];
      rationale: string;
      estUsd: number;
      degraded?: string;
    }
  | { ok: false; reason: string };

export interface RouteOptions {
  priority: Priority;
  rng: Rng;
  /** Money left in the mission's budget, when it has one. */
  remainingUsd?: number;
  /** Every agent in the workspace: reviewers, judges and mergers may come from outside the task's candidates. */
  everyone: Candidate[];
}

interface Scored extends Candidate {
  sample: number;
  utility: number;
  /** The same utility with the posterior mean instead of a sample, and the posterior's standard deviation. */
  meanUtility: number;
  sd: number;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const money = (x: number) => (x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`);

function norm(xs: number[]): (x: number) => number {
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return (x) => (hi > lo ? (x - lo) / (hi - lo) : 0);
}

/**
 * Tries each candidate gets on a task type before pure Thompson sampling: early bad luck (say 1 of 2) would otherwise
 * starve a strong agent for a long time. A small, bounded cost of learning per new agent and task type.
 */
export const WARM_UP_TRIES = 2;

/** How close (in utility) a second agent must be to the leader to join a best-of-n or ensemble (D-63). */
export const MODE_MARGIN: Record<Priority, number> = { quality: 0.25, balanced: 0.15, cheap: 0.1, fast: 0.1 };

/** Thompson sample + cost/latency/Elo utility for every candidate, best first; untried candidates go first. */
export function rank(cands: Candidate[], priority: Priority, rng: Rng, warmUp = WARM_UP_TRIES): Scored[] {
  const l = LAMBDAS[priority];
  const nElo = norm(cands.map((c) => c.score.elo));
  const nCost = norm(cands.map((c) => (c.score.n ? c.score.avgCost : c.estUsd)));
  const nTime = norm(cands.map((c) => c.score.latencyS));
  return cands
    .map((c) => {
      const sample = sampleBeta(c.score.alpha, c.score.beta, rng);
      const cost = c.score.n ? c.score.avgCost : c.estUsd;
      const explore = c.score.n < warmUp ? 1 : 0;
      const rest = l.elo * nElo(c.score.elo) - l.cost * nCost(cost) - l.time * nTime(c.score.latencyS);
      const { alpha: a, beta: b } = c.score;
      const sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
      return { ...c, sample, utility: explore + sample + rest, meanUtility: passRate(c.score) + rest, sd };
    })
    .sort((a, b) => b.utility - a.utility);
}

/** The default mode for a task (ROUTING §3.2), before checking it can be staffed. */
export function defaultMode(task: LearnedTask, priority: Priority): Mode {
  if (priority === "fast") return "single";
  const t = task.type;
  if (priority === "cheap") return t === "write.summary" || t === "data.extraction" ? "cascade" : "single";
  if (t.startsWith("design.") || t.startsWith("plan.")) return "debate";
  if (t.startsWith("code.")) return task.hasTests ? "best_of_n" : "maker_checker";
  if (t === "research.deep_report") return "ensemble";
  if (t === "write.summary" || t === "data.extraction") return "cascade";
  return "single";
}

/** One candidate per vendor, best first: errors correlate within a vendor, so multi-agent modes spread across them. */
function distinctVendors(ranked: Scored[]): Scored[] {
  const seen = new Set<string>();
  return ranked.filter((c) => !seen.has(c.agent.vendor) && seen.add(c.agent.vendor));
}

function rationale(type: string, chosen: Scored, runnerUp: Scored | undefined): string {
  const s = chosen.score;
  const own =
    s.n >= WARM_UP_TRIES
      ? `${chosen.agent.name} chosen: ${pct(passRate(s))} pass rate on ${type} (n=${s.n}), ${money(s.avgCost)} avg`
      : s.n > 0
        ? `${chosen.agent.name} chosen: still learning on ${type} (n=${s.n}), exploring`
        : `${chosen.agent.name} chosen: no history on ${type} yet, exploring`;
  if (!runnerUp) return own;
  const r = runnerUp.score;
  if (s.n > 0 && r.n > 0) {
    const cheaper = s.avgCost < r.avgCost;
    const close = Math.abs(passRate(s) - passRate(r)) < 0.05;
    if (close && cheaper) return `${own}, beats ${runnerUp.agent.name} on cost at similar quality`;
    if (passRate(s) > passRate(r)) return `${own}, ahead of ${runnerUp.agent.name} (${pct(passRate(r))})`;
  }
  return `${own}; next ${runnerUp.agent.name}`;
}

/**
 * A judge, checker or merger from another vendor than everyone it judges, best first; same vendor only as a last
 * resort. Only agents that can do the role's kind of work qualify (a voice model never judges code).
 */
function independent(
  everyone: Scored[],
  exclude: Set<string>,
  vendors: Set<string>,
  can: string,
): Scored | undefined {
  const pool = everyone.filter(
    (c) => !exclude.has(c.agent.id) && c.agent.runnable && c.healthy && c.agent.taskTypes.includes(can),
  );
  return pool.find((c) => !vendors.has(c.agent.vendor)) ?? pool[0];
}

export function routeLearned(task: LearnedTask, candidates: Candidate[], o: RouteOptions): LearnedDecision {
  // A pin is a person's choice: it wins, on its own.
  if (task.pinnedAgentId) {
    const pinned =
      candidates.find((c) => c.agent.id === task.pinnedAgentId) ??
      o.everyone.find((c) => c.agent.id === task.pinnedAgentId);
    if (!pinned) return { ok: false, reason: "the pinned agent no longer exists" };
    if (!pinned.agent.runnable)
      return { ok: false, reason: `${pinned.agent.name} cannot run (no price or connector off)` };
    if (task.sensitivity === "confidential" && !pinned.agent.local)
      return {
        ok: false,
        reason: `${pinned.agent.name} is not local; confidential tasks stay on local models`,
      };
    return {
      ok: true,
      mode: "single",
      agents: [{ agentId: pinned.agent.id, role: "maker" }],
      rationale: `${pinned.agent.name} (pinned)`,
      estUsd: pinned.estUsd,
    };
  }

  const eligibleIds = new Set(
    eligibleAgents(
      task,
      candidates.map((c) => c.agent),
    ).map((a) => a.id),
  );
  const pool = candidates.filter(
    (c) =>
      eligibleIds.has(c.agent.id) &&
      c.healthy &&
      (o.remainingUsd === undefined || c.estUsd <= o.remainingUsd),
  );
  if (candidates.length === 0)
    return { ok: false, reason: "no agents yet: add a connector and build an agent" };
  if (pool.length === 0) {
    if (task.sensitivity === "confidential")
      return { ok: false, reason: "confidential: needs a local model agent" };
    const unhealthy = candidates.filter((c) => eligibleIds.has(c.agent.id) && !c.healthy).length;
    if (unhealthy)
      return { ok: false, reason: `the agents that can do ${task.type} have failing connectors` };
    if (o.remainingUsd !== undefined && candidates.some((c) => eligibleIds.has(c.agent.id)))
      return { ok: false, reason: `no agent fits the remaining budget (${money(o.remainingUsd)})` };
    return { ok: false, reason: `none of your ${candidates.length} agent(s) can do ${task.type}` };
  }

  const ranked = rank(pool, o.priority, o.rng);
  const everyone = rank(o.everyone.length ? o.everyone : pool, o.priority, o.rng);
  const best = ranked[0] as Scored;
  const why = rationale(task.type, best, ranked[1]);
  const wanted: Mode = task.modeExplicit ? (task.mode as Mode) : defaultMode(task, o.priority);
  const single = (degraded?: string): LearnedDecision => ({
    ok: true,
    mode: "single",
    agents: [{ agentId: best.agent.id, role: "maker" }],
    rationale: why,
    estUsd: best.estUsd,
    ...(degraded ? { degraded } : {}),
  });
  const fits = (usd: number) => o.remainingUsd === undefined || usd <= o.remainingUsd;
  const spread = distinctVendors(ranked);
  const label = wanted.replaceAll("_", " ");

  switch (wanted) {
    case "single":
      return single();
    case "best_of_n":
    case "ensemble": {
      const n = Math.max(
        2,
        Math.min(task.modeParams?.n ?? (spread.length >= 3 && o.priority === "quality" ? 3 : 2), 5),
      );
      const source = spread.length >= 2 ? spread : ranked;
      if (source.length < 2) return single(`${label} needs 2+ agents; running single`);
      // A candidate is worth paying for only if it could plausibly be the best: its expected utility plus a standard
      // deviation of its quality reaches the leader's expected utility less a margin. Unknown agents always can; a
      // well-measured weaker one cannot (D-63). A plan or person asking for the mode keeps it as asked.
      const lead = Math.max(...source.map((c) => c.meanUtility));
      const plausible = (c: Scored) => c.meanUtility + c.sd >= lead - MODE_MARGIN[o.priority];
      const picked = (task.modeExplicit ? source : source.filter(plausible)).slice(0, n);
      if (picked.length < 2)
        return single(
          `no second agent is close to ${best.agent.name} on ${task.type}; ${label} would add a weaker result, so running single`,
        );
      const merger =
        wanted === "ensemble" ? (independent(everyone, new Set(), new Set(), task.type) ?? best) : undefined;
      // Tests decide best-of-n; a judge from outside the candidates breaks ties between passing results (two
      // judgements, both orders). Without one, the cheaper passing result wins.
      const judge =
        wanted === "best_of_n"
          ? independent(
              everyone,
              new Set(picked.map((c) => c.agent.id)),
              new Set(picked.map((c) => c.agent.vendor)),
              "judge.pairwise",
            )
          : undefined;
      const usd =
        picked.reduce((s, c) => s + c.estUsd, 0) + (merger?.estUsd ?? 0) + (judge ? judge.estUsd * 2 : 0);
      if (!fits(usd))
        return single(`${label} would cost ${money(usd)}, over the remaining budget; running single`);
      return {
        ok: true,
        mode: wanted,
        agents: [
          ...picked.map((c) => ({ agentId: c.agent.id, role: "candidate" as const })),
          ...(merger ? [{ agentId: merger.agent.id, role: "merger" as const }] : []),
          ...(judge ? [{ agentId: judge.agent.id, role: "judge" as const }] : []),
        ],
        rationale: `${wanted === "ensemble" ? "ensemble" : `best of ${picked.length}`}: ${picked.map((c) => c.agent.name).join(", ")} · ${why}`,
        estUsd: usd,
        ...(spread.length < picked.length
          ? { degraded: "fewer vendors than candidates: some share a vendor" }
          : {}),
      };
    }
    case "maker_checker": {
      const checker = independent(
        everyone,
        new Set([best.agent.id]),
        new Set([best.agent.vendor]),
        "review.rubric",
      );
      if (!checker) return single("maker–checker needs a second agent; running single");
      const usd = best.estUsd + checker.estUsd;
      if (!fits(usd)) return single("maker–checker would go over the remaining budget; running single");
      return {
        ok: true,
        mode: "maker_checker",
        agents: [
          { agentId: best.agent.id, role: "maker" },
          { agentId: checker.agent.id, role: "checker" },
        ],
        rationale: `${why}; checked by ${checker.agent.name}${checker.agent.vendor === best.agent.vendor ? " (same vendor: no other available)" : ""}`,
        estUsd: usd,
      };
    }
    case "debate": {
      const [a, b] = spread.length >= 2 ? spread : ranked;
      if (!a || !b) return single("debate needs 2+ agents; running single");
      const judge =
        independent(
          everyone,
          new Set([a.agent.id, b.agent.id]),
          new Set([a.agent.vendor, b.agent.vendor]),
          "judge.pairwise",
        ) ?? a;
      const usd = a.estUsd * 2 + b.estUsd * 2 + judge.estUsd * 2;
      if (!fits(usd)) return single("debate would go over the remaining budget; running single");
      return {
        ok: true,
        mode: "debate",
        agents: [
          { agentId: a.agent.id, role: "candidate" },
          { agentId: b.agent.id, role: "candidate" },
          { agentId: judge.agent.id, role: "judge" },
          { agentId: judge.agent.id, role: "merger" },
        ],
        rationale: `debate: ${a.agent.name} vs ${b.agent.name}, judged by ${judge.agent.name}`,
        estUsd: usd,
      };
    }
    case "cascade": {
      // Cheapest first; each step up only when the cheaper one fails its checks.
      const ladder = [...pool].sort(
        (x, y) => (x.score.n ? x.score.avgCost : x.estUsd) - (y.score.n ? y.score.avgCost : y.estUsd),
      );
      if (ladder.length < 2) return single("cascade needs 2+ agents; running single");
      const steps = ladder.slice(0, 3);
      return {
        ok: true,
        mode: "cascade",
        agents: steps.map((c) => ({ agentId: c.agent.id, role: "maker" as const })),
        rationale: `cascade: ${steps.map((c) => c.agent.name).join(" → ")} (cheapest first, escalate on a failed check)`,
        estUsd: steps[0]?.estUsd ?? 0,
      };
    }
    case "pipeline": {
      const steps = (task.modeParams?.steps ?? []).map(
        (s) =>
          o.everyone.find((c) => c.agent.id === s.agentId) ??
          candidates.find((c) => c.agent.id === s.agentId),
      );
      if (!steps.length || steps.some((s) => !s))
        return single("the pipeline names agents that are gone; running single");
      return {
        ok: true,
        mode: "pipeline",
        agents: (steps as Candidate[]).map((c) => ({ agentId: c.agent.id, role: "maker" as const })),
        rationale: `pipeline: ${(steps as Candidate[]).map((c) => c.agent.name).join(" → ")}`,
        estUsd: (steps as Candidate[]).reduce((s, c) => s + c.estUsd, 0),
      };
    }
  }
}
