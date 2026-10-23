import { z } from "zod";

/**
 * Golden-mission eval runs (BUILD_PLAN M5, PRD §7): every mission run under every routing strategy, scored by hidden
 * checks, summarised per strategy, and judged against the PRD's targets.
 */

/** learned, static, or `single:<agent name>` (one agent alone, one shot). */
export const EvalStrategy = z.string().regex(/^(learned|static|single:[\w.-]+)$/);

export const EvalMissionResult = z.object({
  mission: z.string().min(1),
  strategy: EvalStrategy,
  /** The hidden scorer's verdict on what the run produced (Brio's own verdict aside). */
  passed: z.boolean(),
  /** How the mission ended in Brio (done, failed, or timed out). */
  status: z.string(),
  costUsd: z.number().nonnegative(),
  minutes: z.number().nonnegative(),
  attempts: z.number().int().nonnegative(),
  reason: z.string().max(2000).optional(),
  /** Which pass over the golden set (from 1), when a run repeats it so the learned router has history. */
  epoch: z.number().int().positive().optional(),
});
export type EvalMissionResult = z.infer<typeof EvalMissionResult>;

export const EvalStrategySummary = z.object({
  strategy: EvalStrategy,
  missions: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  /** 0–1. */
  passRate: z.number().min(0).max(1),
  /** Averages per mission. */
  costUsd: z.number().nonnegative(),
  minutes: z.number().nonnegative(),
  attempts: z.number().nonnegative(),
  /** Pass rate per dollar spent per mission (PRD: "cost-adjusted pass rate"). */
  costAdjusted: z.number().nonnegative(),
});
export type EvalStrategySummary = z.infer<typeof EvalStrategySummary>;

export const EvalVerdict = z.object({
  /** The single agent with the best pass rate (ties: the cheaper). */
  bestSingle: z.string().nullable(),
  /** Brio (learned) pass rate minus the best single agent's, in points. Target ≥ 15. */
  liftPoints: z.number().nullable(),
  /** Brio's cost per mission ÷ the best single agent's. Target ≤ 1.3. */
  costRatio: z.number().nullable(),
  met: z.boolean().nullable(),
  /** Learned vs static routing on cost-adjusted pass rate, in percent. Target ≥ 10 (after 200 missions). */
  routerGainPct: z.number().nullable(),
  routerMet: z.boolean().nullable(),
});
export type EvalVerdict = z.infer<typeof EvalVerdict>;

export const EvalRun = z.object({
  /** offline: simulated agents of known skill (CI, nightly); live: the owner's real agents and keys. */
  mode: z.enum(["offline", "live"]),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  missions: z.array(z.string()).max(500),
  /** Passes over the golden set; summaries and the verdict are for the last one. */
  epochs: z.number().int().positive().default(1),
  summaries: z.array(EvalStrategySummary).max(50),
  results: z.array(EvalMissionResult).max(25_000),
  verdict: EvalVerdict,
  notes: z.string().max(4000).optional(),
});
export type EvalRun = z.infer<typeof EvalRun>;
