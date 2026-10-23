// The scoreboard's maths (ROUTING_AND_QUALITY §3.1, §5), pure. One row per (agent key, task type): a Beta posterior on
// passing verification, an Elo rating from pairwise judgements, and running averages of cost and latency.

export interface Score {
  alpha: number;
  beta: number;
  elo: number;
  /** EMA of USD per attempt. */
  avgCost: number;
  /** EMA of seconds per attempt (the "p50" column; an EMA tracks the median closely for these skewed latencies). */
  latencyS: number;
  n: number;
  updatedAt: Date;
}

export const ELO_START = 1200;
export const HALF_LIFE_DAYS = 60;
/** Weight a new model's inherited prior carries (ROUTING §5). */
export const NEW_MODEL_WEIGHT = 5;
const EMA = 0.2;

export const freshScore = (now: Date): Score => ({
  alpha: 1,
  beta: 1,
  elo: ELO_START,
  avgCost: 0,
  latencyS: 0,
  n: 0,
  updatedAt: now,
});

/** Expected pass rate. */
export const passRate = (s: Pick<Score, "alpha" | "beta">) => s.alpha / (s.alpha + s.beta);

/** Agents are scored per connector preset and model: "anthropic/claude-sonnet-5-5", "codex/gpt-6.1-sol". */
export const agentKey = (vendorOrAdapter: string, model: string) => `${vendorOrAdapter}/${model}`;

/**
 * Old evidence fades (half-life 60 days) so a model that improved can climb: the posterior shrinks toward Beta(1,1)
 * and Elo toward its start. Applied before every read and update.
 */
export function decay(s: Score, now: Date, halfLifeDays = HALF_LIFE_DAYS): Score {
  const days = Math.max(0, (now.getTime() - s.updatedAt.getTime()) / 86_400_000);
  if (days === 0) return s;
  const f = 0.5 ** (days / halfLifeDays);
  return {
    ...s,
    alpha: 1 + (s.alpha - 1) * f,
    beta: 1 + (s.beta - 1) * f,
    elo: ELO_START + (s.elo - ELO_START) * f,
    updatedAt: now,
  };
}

export type Outcome = "pass" | "revise" | "fail";

/** A verification verdict: pass α+1, fail β+1, revise β+0.5; cost and latency EMAs move toward this attempt. */
export function applyOutcome(
  prev: Score,
  o: { outcome: Outcome; costUsd: number; seconds: number; now: Date },
): Score {
  const s = decay(prev, o.now);
  const ema = (old: number, x: number) => (s.n === 0 ? x : old + EMA * (x - old));
  return {
    alpha: s.alpha + (o.outcome === "pass" ? 1 : 0),
    beta: s.beta + (o.outcome === "fail" ? 1 : o.outcome === "revise" ? 0.5 : 0),
    elo: s.elo,
    avgCost: ema(s.avgCost, Math.max(0, o.costUsd)),
    latencyS: ema(s.latencyS, Math.max(0, o.seconds)),
    n: s.n + 1,
    updatedAt: o.now,
  };
}

/** A person's thumbs: up +0.5 α, down +1 β. */
export function applyRating(prev: Score, rating: 1 | -1, now: Date): Score {
  const s = decay(prev, now);
  return {
    ...s,
    alpha: s.alpha + (rating > 0 ? 0.5 : 0),
    beta: s.beta + (rating < 0 ? 1 : 0),
    updatedAt: now,
  };
}

/** Elo for one pairwise judgement (winner beats loser; a tie moves both toward each other). */
export function eloUpdate(a: number, b: number, result: "a" | "b" | "tie", k = 24): [number, number] {
  const ea = 1 / (1 + 10 ** ((b - a) / 400));
  const sa = result === "a" ? 1 : result === "b" ? 0 : 0.5;
  const delta = k * (sa - ea);
  return [a + delta, b - delta];
}

/**
 * A model new to the scoreboard inherits its predecessor's (same vendor, same task type) pass rate at weight 5, so it
 * neither starts blind nor inherits all of the old model's confidence.
 */
export function inheritPrior(previous: Score, now: Date, weight = NEW_MODEL_WEIGHT): Score {
  const p = passRate(decay(previous, now));
  return {
    ...freshScore(now),
    alpha: 1 + p * weight,
    beta: 1 + (1 - p) * weight,
    elo: previous.elo,
    avgCost: previous.avgCost,
    latencyS: previous.latencyS,
  };
}
