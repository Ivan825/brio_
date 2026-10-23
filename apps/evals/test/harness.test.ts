// M5 acceptance (evals): an offline run produces a comparable metrics table across strategies, with the PRD verdict
// measurable. A small slice of the golden set keeps it fast enough for every CI run; the nightly job runs all thirty.
// Needs Postgres and Docker.

import { renderEvalTable } from "@brio/core";
import { hasTestDatabase } from "@brio/db/testing";
import { dockerAvailable } from "@brio/runner";
import { EvalRun } from "@brio/schema";
import { describe, expect, it } from "vitest";
import { runEvals, SIM_AGENTS, SimVendors } from "../src/index";

const hasDocker = await dockerAvailable();

describe.skipIf(!hasTestDatabase || !hasDocker)("eval harness (offline)", () => {
  it("runs missions under each strategy, scores them with hidden checks, and measures the PRD targets", async () => {
    const sim = new SimVendors();
    const run = await runEvals({
      mode: "offline",
      missions: ["calc-add", "extract-invoice"],
      strategies: ["single:mini", "static", "learned"],
      agents: SIM_AGENTS.map((a) => ({
        name: a.name,
        connector: a.connector,
        model: a.model,
        apiKey: ["sim", a.connector, "0123456789abcdefghijklmnop"].join("-"),
        price: a.price,
        ...(a.apiStyle ? { apiStyle: a.apiStyle } : {}),
      })),
      fetch: sim.fetch,
      timeoutMs: 5 * 60_000,
      onMission: (strategy, m) => {
        sim.strategy = strategy;
        sim.mission = m;
      },
    });
    expect(EvalRun.safeParse(run).success).toBe(true);
    expect(run.results).toHaveLength(6);
    expect(run.summaries.map((s) => s.strategy).sort()).toEqual(["learned", "single:mini", "static"]);
    for (const r of run.results) {
      expect(r.attempts).toBeGreaterThan(0);
      expect(r.reason).toBeTruthy();
    }
    // Every simulated vendor took part, and the verdict could be computed.
    expect([...sim.calls.keys()].sort()).toEqual(["coder", "gen", "mini"]);
    expect(run.verdict.bestSingle).toBe("single:mini");
    expect(run.verdict.liftPoints).not.toBeNull();
    expect(run.verdict.routerGainPct === null || typeof run.verdict.routerGainPct === "number").toBe(true);
    // Brio's learned router fixes the seeded bug (revisions, a judge, another vendor if need be).
    expect(run.results.find((r) => r.strategy === "learned" && r.mission === "calc-add")?.passed).toBe(true);
    expect(renderEvalTable(run.summaries, run.verdict)).toContain("| Strategy |");
  }, 900_000);
});
