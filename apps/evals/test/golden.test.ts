import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { goldenKeys, loadGolden } from "../src/index";

describe("golden missions", () => {
  it("includes the M3 target and every mission is valid", () => {
    expect(goldenKeys()).toContain("oauth-login");
    for (const k of goldenKeys()) expect(loadGolden(k).goal.length).toBeGreaterThan(20);
  });

  it("the oauth-login fixture's own tests pass with plain node, as the sandbox runs them", () => {
    const { repoDir, expect: e } = loadGolden("oauth-login");
    expect(e).toMatchObject({ minTasks: 4, contractTask: true });
    const out = execFileSync("node", ["--test"], { cwd: repoDir, encoding: "utf8" });
    expect(out).toMatch(/# pass 1/);
  });
});
