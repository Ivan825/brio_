// The evals dashboard's API: save a run, list runs with their summaries, read one with its per-mission results.
import { hasTestDatabase } from "@brio/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";

const run = {
  mode: "offline",
  startedAt: "2026-10-23T10:00:00.000Z",
  finishedAt: "2026-10-23T10:30:00.000Z",
  missions: ["calc-add"],
  summaries: [
    {
      strategy: "learned",
      missions: 1,
      passed: 1,
      passRate: 1,
      costUsd: 0.02,
      minutes: 0.5,
      attempts: 2,
      costAdjusted: 50,
    },
    {
      strategy: "single:mini",
      missions: 1,
      passed: 0,
      passRate: 0,
      costUsd: 0.01,
      minutes: 0.2,
      attempts: 1,
      costAdjusted: 0,
    },
  ],
  results: [
    {
      mission: "calc-add",
      strategy: "learned",
      passed: true,
      status: "done",
      costUsd: 0.02,
      minutes: 0.5,
      attempts: 2,
    },
    {
      mission: "calc-add",
      strategy: "single:mini",
      passed: false,
      status: "failed",
      costUsd: 0.01,
      minutes: 0.2,
      attempts: 1,
    },
  ],
  verdict: {
    bestSingle: "single:mini",
    liftPoints: 100,
    costRatio: 2,
    met: false,
    routerGainPct: null,
    routerMet: null,
  },
};

describe.skipIf(!hasTestDatabase)("eval runs API", () => {
  let h: Harness;
  let c: Client;
  beforeAll(async () => {
    h = await startHarness({ runner: false });
    c = new Client(h);
    await c.signIn("evals@example.com");
    await c.request("POST", "/v1/workspaces", { name: "Evals" });
  });
  afterAll(async () => h?.close());

  it("saves a run, lists it, and returns it whole", async () => {
    const saved = await c.request("POST", "/v1/evals/runs", run);
    expect(saved.statusCode, saved.body).toBe(201);
    const id = saved.json().run.id;
    const list = (await c.request("GET", "/v1/evals/runs")).json().runs;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, mode: "offline", missions: 1, verdict: { met: false } });
    expect(list[0].results).toBeUndefined();
    const one = (await c.request("GET", `/v1/evals/runs/${id}`)).json().run;
    expect(one.results).toHaveLength(2);
  });

  it("refuses a malformed run", async () => {
    const bad = await c.request("POST", "/v1/evals/runs", {
      ...run,
      results: [{ mission: "x", strategy: "nope" }],
    });
    expect(bad.statusCode).toBe(400);
  });
});
