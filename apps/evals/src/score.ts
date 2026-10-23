// Hidden scorers (BUILD_PLAN M5): judge what a run produced, independently of Brio's own verdict. Code is scored by
// hidden tests (or, for test-writing missions, by mutants the tests must catch) through an injected `exec` — a sandbox
// in the harness, plain node for the fixtures' own integrity test. Answers are scored by patterns or JSON.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { extractJson } from "@brio/core";
import type { LoadedEvalMission, Scorer } from "./golden";

export type Exec = (cwd: string, command: string) => Promise<{ exitCode: number; output: string }>;

export interface ScoreResult {
  passed: boolean;
  reason: string;
}

/** Whether `actual` contains `expect`: objects by key, arrays element by element (same length), values exactly. */
export function contains(expect: unknown, actual: unknown): boolean {
  if (Array.isArray(expect))
    return (
      Array.isArray(actual) &&
      actual.length === expect.length &&
      expect.every((e, i) => contains(e, actual[i]))
    );
  if (expect && typeof expect === "object")
    return (
      !!actual &&
      typeof actual === "object" &&
      Object.entries(expect).every(([k, v]) => contains(v, (actual as Record<string, unknown>)[k]))
    );
  return Object.is(expect, actual);
}

/** A pattern, where a leading (?i) means case-insensitive (JavaScript has no inline flags). */
const pattern = (p: string) => (p.startsWith("(?i)") ? new RegExp(p.slice(4), "i") : new RegExp(p));

export function scoreAnswer(scorer: Extract<Scorer, { kind: "text" | "json" }>, answer: string): ScoreResult {
  if (scorer.kind === "text") {
    const missing = scorer.patterns.filter((p) => !pattern(p).test(answer));
    const present = scorer.forbid.filter((p) => pattern(p).test(answer));
    if (missing.length) return { passed: false, reason: `missing: ${missing.join(", ")}` };
    if (present.length) return { passed: false, reason: `should not say: ${present.join(", ")}` };
    return { passed: true, reason: `all ${scorer.patterns.length} required points present` };
  }
  const raw = extractJson(answer);
  if (!raw) return { passed: false, reason: "no JSON in the answer" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { passed: false, reason: "the answer's JSON does not parse" };
  }
  return contains(scorer.expect, parsed)
    ? { passed: true, reason: "the JSON holds every expected value" }
    : { passed: false, reason: `expected ${JSON.stringify(scorer.expect).slice(0, 300)}` };
}

/** Copies the hidden tests (not the mutants) into the result's directory. */
function placeHidden(m: LoadedEvalMission, workdir: string) {
  if (!existsSync(m.hiddenDir)) return;
  cpSync(m.hiddenDir, join(workdir, "hidden"), {
    recursive: true,
    filter: (src) => !src.startsWith(join(m.hiddenDir, "mutants")),
  });
}

/** Scores a code result checked out in `workdir` (hidden tests or mutants). */
export async function scoreCode(m: LoadedEvalMission, workdir: string, exec: Exec): Promise<ScoreResult> {
  const s = m.scorer;
  if (s.kind === "tests") {
    placeHidden(m, workdir);
    const r = await exec(workdir, s.command);
    return r.exitCode === 0
      ? { passed: true, reason: "the hidden tests pass" }
      : { passed: false, reason: `the hidden tests fail: ${r.output.slice(-600)}` };
  }
  if (s.kind !== "mutants") throw new Error(`${m.key}: not a code scorer`);
  const base = await exec(workdir, s.command);
  if (base.exitCode !== 0)
    return { passed: false, reason: `the tests fail on the real code: ${base.output.slice(-400)}` };
  const survived: string[] = [];
  for (const name of s.mutants) {
    const dir = join(m.hiddenDir, "mutants", name);
    const files = readTreeList(dir);
    const originals = new Map(
      files.map((f) => [f, existsSync(join(workdir, f)) ? readFileSync(join(workdir, f)) : null]),
    );
    for (const f of files) {
      mkdirSync(dirname(join(workdir, f)), { recursive: true });
      writeFileSync(join(workdir, f), readFileSync(join(dir, f)));
    }
    const r = await exec(workdir, s.command);
    if (r.exitCode === 0) survived.push(name);
    for (const [f, content] of originals) if (content) writeFileSync(join(workdir, f), content);
  }
  return survived.length
    ? {
        passed: false,
        reason: `the tests miss ${survived.length} of ${s.mutants.length} bugs: ${survived.join(", ")}`,
      }
    : { passed: true, reason: `the tests catch all ${s.mutants.length} seeded bugs` };
}

/** Paths of every file under a directory, relative to it. */
function readTreeList(root: string, rel = ""): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? readTreeList(join(root, e.name), join(rel, e.name)) : [join(rel, e.name)],
  );
}
