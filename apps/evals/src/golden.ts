// Golden missions (BUILD_PLAN M3 target, M5 harness): a goal, a fixture repository, and what a good run produces.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
