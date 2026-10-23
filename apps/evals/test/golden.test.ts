import { execFile, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  EVAL_CATEGORIES,
  type Exec,
  evalMissionKeys,
  goldenKeys,
  type LoadedEvalMission,
  loadEvalMission,
  loadGolden,
  scoreAnswer,
  scoreCode,
} from "../src/index";

describe("golden missions", () => {
  it("includes the M3 target and every mission is valid", () => {
    expect(goldenKeys()).toContain("oauth-login");
    const evals = new Set(evalMissionKeys());
    for (const k of goldenKeys().filter((x) => !evals.has(x)))
      expect(loadGolden(k).goal.length).toBeGreaterThan(20);
  });

  it("the oauth-login fixture's own tests pass with plain node, as the sandbox runs them", () => {
    const { repoDir, expect: e } = loadGolden("oauth-login");
    expect(e).toMatchObject({ minTasks: 4, contractTask: true });
    const out = execFileSync("node", ["--test"], { cwd: repoDir, encoding: "utf8" });
    expect(out).toMatch(/# pass 1/);
  });
});

// The fixtures are ours (trusted), so their integrity is checked with plain node on the host. Agent output is only
// ever scored in a sandbox (src/run.ts).
const hostExec: Exec = (cwd, command) =>
  new Promise((resolve) =>
    execFile("sh", ["-c", command], { cwd, timeout: 60_000 }, (err, stdout, stderr) =>
      resolve({ exitCode: err ? ((err as { code?: number }).code ?? 1) : 0, output: `${stdout}${stderr}` }),
    ),
  );

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** The fixture repository with each task's right or wrong files laid over it. */
function checkout(m: LoadedEvalMission, pick: (taskKey: string) => "right" | "wrong" | "none"): string {
  const dir = mkdtempSync(join(tmpdir(), `brio-golden-${m.key}-`));
  dirs.push(dir);
  if (m.repoDir) cpSync(m.repoDir, dir, { recursive: true });
  for (const t of m.plan.tasks) {
    const side = pick(t.key);
    if (side === "none") continue;
    for (const [p, content] of Object.entries(m.sim[t.key]?.[side].files ?? {})) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), content);
    }
  }
  return dir;
}

describe("eval missions", () => {
  const keys = evalMissionKeys();

  it("number thirty, across every category", () => {
    expect(keys).toHaveLength(30);
    const cats = new Set(keys.map((k) => loadEvalMission(k).category));
    expect([...cats].sort()).toEqual([...EVAL_CATEGORIES].sort());
  });

  for (const key of keys) {
    const m = loadEvalMission(key);
    it(`${key}: the right work passes its checks and the hidden scorer; wrong work does not`, async () => {
      expect(m.plan.tasks.every((t) => m.sim[t.key])).toBe(true);
      if (m.scorer.kind === "text" || m.scorer.kind === "json") {
        const task = m.sim[m.scorer.task];
        expect(task, `${key}: scorer task`).toBeDefined();
        expect(scoreAnswer(m.scorer, task?.right.text ?? "")).toMatchObject({ passed: true });
        expect(scoreAnswer(m.scorer, task?.wrong.text ?? "")).toMatchObject({ passed: false });
        return;
      }
      // Right everywhere: every task's own command checks pass, and so does the hidden scorer.
      const right = checkout(m, () => "right");
      for (const t of m.plan.tasks)
        for (const c of t.contract.acceptance)
          if (c.command)
            expect((await hostExec(right, c.command)).exitCode, `${key}/${t.key}: ${c.command}`).toBe(0);
      expect(await scoreCode(m, right, hostExec)).toMatchObject({ passed: true });
      // One task wrong (the rest right): the hidden scorer fails it.
      for (const t of m.plan.tasks.filter((x) => Object.keys(m.sim[x.key]?.wrong.files ?? {}).length)) {
        const wrong = checkout(m, (k) => (k === t.key ? "wrong" : "right"));
        expect((await scoreCode(m, wrong, hostExec)).passed, `${key}/${t.key} wrong`).toBe(false);
      }
      // Nothing done: fails too.
      if (m.scorer.kind === "tests")
        expect(
          (
            await scoreCode(
              m,
              checkout(m, () => "none"),
              hostExec,
            )
          ).passed,
        ).toBe(false);
    }, 60_000);
  }
});
