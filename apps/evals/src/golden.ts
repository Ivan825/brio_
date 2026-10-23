// Golden missions (BUILD_PLAN M3 target, M5 harness): a goal, a fixture repository, and what a good run produces.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PlanGraph } from "@brio/schema";
import { z } from "zod";

export const GOLDEN_DIR = join(import.meta.dirname, "..", "golden");

export const GoldenMission = z.object({
  key: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  goal: z.string().min(1),
  expect: z.object({
    minTasks: z.number().int().positive(),
    contractTask: z.boolean(),
    vendors: z.number().int().positive(),
    checks: z.array(z.string()),
  }),
});
export type GoldenMission = z.infer<typeof GoldenMission>;

export interface LoadedGolden extends GoldenMission {
  /** The fixture repository's directory (copy it into a fresh git repository before a run). */
  repoDir: string;
}

export function loadGolden(key: string): LoadedGolden {
  const dir = join(GOLDEN_DIR, key);
  const mission = GoldenMission.parse(JSON.parse(readFileSync(join(dir, "mission.json"), "utf8")));
  const repoDir = join(dir, "repo");
  if (!existsSync(repoDir)) throw new Error(`golden mission ${key} has no repo/`);
  return { ...mission, repoDir };
}

export function goldenKeys(): string[] {
  return readdirSync(GOLDEN_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(GOLDEN_DIR, d.name, "mission.json")))
    .map((d) => d.name)
    .sort();
}

// ---- Eval missions (M5): a fixed plan, a hidden scorer, and right/wrong outputs for the offline simulation --------

export const EVAL_CATEGORIES = [
  "bugfix",
  "feature",
  "tests",
  "refactor",
  "docs",
  "research",
  "data",
] as const;

export const Scorer = z.discriminatedUnion("kind", [
  /** Hidden tests (hidden/*.test.mjs) copied into the result and run. */
  z.object({ kind: z.literal("tests"), command: z.string().min(1) }),
  /** The agent wrote tests: they must pass on the code and fail on every mutant (hidden/mutants/<name>/). */
  z.object({ kind: z.literal("mutants"), command: z.string().min(1), mutants: z.array(z.string()).min(1) }),
  /** A task's answer must match every pattern and none of the forbidden ones. */
  z.object({
    kind: z.literal("text"),
    task: z.string(),
    patterns: z.array(z.string()).min(1),
    forbid: z.array(z.string()).default([]),
  }),
  /** A task's answer must hold a JSON object containing `expect`. */
  z.object({ kind: z.literal("json"), task: z.string(), expect: z.unknown() }),
]);
export type Scorer = z.infer<typeof Scorer>;

export const EvalMissionSpec = z.object({
  key: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  goal: z.string().min(20),
  category: z.enum(EVAL_CATEGORIES),
  plan: PlanGraph,
  scorer: Scorer,
});
export type EvalMissionSpec = z.infer<typeof EvalMissionSpec>;

/** What a simulated agent produces for a task: files written in the worktree, and its final answer. */
export interface SimOutcome {
  files: Record<string, string>;
  text: string;
}

export interface LoadedEvalMission extends EvalMissionSpec {
  dir: string;
  /** The fixture repository (null for missions without one). */
  repoDir: string | null;
  hiddenDir: string;
  sim: Record<string, { right: SimOutcome; wrong: SimOutcome }>;
}

function readTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(root)) return out;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out[relative(root, p)] = readFileSync(p, "utf8");
    }
  };
  walk(root);
  return out;
}

export function evalMissionKeys(): string[] {
  return goldenKeys().filter((k) => {
    const raw = JSON.parse(readFileSync(join(GOLDEN_DIR, k, "mission.json"), "utf8")) as { plan?: unknown };
    return raw.plan !== undefined;
  });
}

export function loadEvalMission(key: string): LoadedEvalMission {
  const dir = join(GOLDEN_DIR, key);
  const spec = EvalMissionSpec.parse(JSON.parse(readFileSync(join(dir, "mission.json"), "utf8")));
  const sim: LoadedEvalMission["sim"] = {};
  for (const t of spec.plan.tasks) {
    const base = join(dir, "sim", t.key);
    const side = (s: "right" | "wrong"): SimOutcome => ({
      files: readTree(join(base, s)),
      text: existsSync(join(base, `${s}.md`)) ? readFileSync(join(base, `${s}.md`), "utf8") : "Done.",
    });
    sim[t.key] = { right: side("right"), wrong: side("wrong") };
  }
  const repoDir = join(dir, "repo");
  return { ...spec, dir, repoDir: existsSync(repoDir) ? repoDir : null, hiddenDir: join(dir, "hidden"), sim };
}
