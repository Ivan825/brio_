// M9 acceptance (budgets): two agents spend in parallel against one mission budget; past 80% the board warns, and the
// moment the mission's spend crosses its budget a budget.stop is emitted and every running attempt is halted — within
// five seconds — as limit_exceeded, its task blocked until a person raises the budget. Before dispatch, an attempt
// whose estimate does not fit what is left (the workspace's month here) is refused. Needs Postgres.
import { readEventsSince, schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { and, eq, gt } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";
import { type CallInfo, ScriptedVendors, taskTitle } from "./vendors";

const OPENAI_KEY = ["sk", "proj", "budget0123456789abcdefghi"].join("-");

const task = (key: string, title: string) => ({
  key,
  type: "write.summary",
  title,
  contract: {
    objective: title,
    inputs: [],
    outputs: [{ kind: "report", description: title }],
    acceptance: [{ kind: "diff_scope", hard: true }],
    constraints: [],
    sensitivity: "internal",
  },
  dependsOn: [],
  suggestedMode: "single",
});

describe.skipIf(!hasTestDatabase)("M9 acceptance: budgets", () => {
  // Every call costs $0.01 (1,000 input tokens at $10 per million); agents keep calling a tool until stopped.
  const vendors = new ScriptedVendors(async (call: CallInfo) => {
    const title = taskTitle(call.body) ?? "";
    if (title.startsWith("Loop")) {
      await new Promise((r) => setTimeout(r, 250));
      return { tools: [{ name: "keep_going", args: {} }] };
    }
    return { text: "done" };
  });
  let h: Harness;
  let c: Client;
  let workspaceId: string;
  let agentId: string;

  beforeAll(async () => {
    h = await startHarness({ fetch: vendors.fetch });
    c = new Client(h);
    await c.signIn("budgets@example.com");
    workspaceId = (await c.request("POST", "/v1/workspaces", { name: "Budgets" })).json().workspace.id;
    const openai = (
      await c.request("POST", "/v1/connectors", { registryKey: "openai-api", apiKey: OPENAI_KEY })
    ).json().connector;
    agentId = (
      await c.request("POST", "/v1/agents", {
        connectorId: openai.id,
        name: "spender",
        model: "gpt-coder",
        priceOverride: { inputPerM: 10, outputPerM: 0, cachedInputPerM: null, cacheWritePerM: null },
        limits: { maxTokens: 100, maxCostUsd: 1 },
      })
    ).json().agent.id;
  });
  afterAll(async () => {
    await h?.close();
  });

  it("halts every running attempt within 5 s of the mission's spend crossing its budget", async () => {
    const m = await c.request("POST", "/v1/missions", {
      goal: "Spend",
      budget: { usd: 0.06 },
      plan: { tasks: [task("a", "Loop A"), task("b", "Loop B")], assumptions: [], questions: [] },
      routing: { strategy: "single", agentId },
    });
    expect(m.statusCode, m.body).toBe(201);
    const id = m.json().mission.id;
    expect((await c.request("POST", `/v1/missions/${id}/plans/1/approve`)).statusCode).toBe(200);

    const rows = () =>
      h.db.db
        .select({ a: schema.attempts, key: schema.tasks.key, t: schema.tasks })
        .from(schema.attempts)
        .innerJoin(schema.tasks, eq(schema.tasks.id, schema.attempts.taskId))
        .where(and(eq(schema.tasks.missionId, id), gt(schema.tasks.planVersion, 0)));
    for (let i = 0; i < 300; i++) {
      const r = await rows();
      if (r.length === 2 && r.every((x) => x.a.status !== "running" && x.a.status !== "queued")) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    const done = await rows();
    expect(done).toHaveLength(2);
    // Stopped by the guard, or by its own limit when that limit was what the budget had left: either way, the budget.
    for (const { a } of done) {
      expect(a.status).toBe("failed");
      expect(a.exitReason).toMatch(
        /^limit_exceeded: (budget: the mission's budget of \$0\.06 is spent|cost \$0\.0\d+ passed the limit of \$0\.06)/,
      );
    }

    const events = await readEventsSince(h.db.db, id, 0, 10_000);
    const warns = events.filter((e) => e.type === "budget.warn");
    const story = `${events.map((e) => `${e.type} ${JSON.stringify(e.payload).slice(0, 160)}`).join("\n")}\n${done.map((d) => `${d.key}: ${d.a.status} ${d.a.exitReason} $${d.a.costUsd}`).join("\n")}`;
    const stops = events.filter((e) => e.type === "budget.stop");
    expect(warns, story).toHaveLength(1);
    expect(stops).toHaveLength(1);
    expect(stops[0]?.payload).toMatchObject({ scope: "mission", scopeId: id, limitUsd: 0.06 });
    // Within five seconds of the stop, both attempts are over.
    const stopAt = new Date(stops[0]!.ts).getTime();
    const finished = events.filter((e) => e.type === "attempt.finished").map((e) => new Date(e.ts).getTime());
    expect(finished).toHaveLength(2);
    for (const f of finished) expect(f - stopAt).toBeLessThan(5000);
    // Each attempt alone may spend at most what the budget had left when it started (its own limit); together they
    // stop within the five seconds above, whatever they had in flight.
    const spent = done.reduce((n, x) => n + Number(x.a.costUsd), 0);
    expect(spent).toBeGreaterThanOrEqual(0.06);
    for (const { a } of done) expect(Number(a.costUsd)).toBeLessThanOrEqual(0.07);

    // The tasks wait for a person; raising the budget lets them run again. (The 5 s bound is on the attempts, above;
    // the orchestrator blocks the tasks on its next tick, which a busy machine may delay.)
    for (let i = 0; i < 150; i++) {
      const r = await rows();
      if (r.every((x) => x.t.status === "blocked")) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    const blocked = await rows();
    expect(blocked.map((x) => x.t.status)).toEqual(["blocked", "blocked"]);
    for (const x of blocked)
      expect(x.t.blockedReason).toMatch(/^budget: the mission's budget of \$0\.06 is spent/);
    const raised = await c.request("PUT", `/v1/missions/${id}/budget`, { usd: 0.07 });
    expect(raised.statusCode, raised.body).toBe(200);
    expect(raised.json().resumed.sort()).toEqual(["a", "b"]);
  }, 60_000);

  it("refuses work before dispatch when the workspace's month has no room for it", async () => {
    const set = await c.request("PUT", "/v1/budgets", { scopeKind: "workspace", limitUsd: 0.01 });
    expect(set.statusCode, set.body).toBe(200);
    const view = (await c.request("GET", "/v1/budgets")).json();
    expect(view.workspace.limitUsd).toBe(0.01);
    expect(view.workspace.spentUsd).toBeGreaterThan(0.06);
    expect(view.agents.find((a: { agentId: string }) => a.agentId === agentId).spentUsd).toBeGreaterThan(
      0.06,
    );

    const m = await c.request("POST", "/v1/missions", {
      goal: "One more",
      plan: { tasks: [task("c", "Summarise")], assumptions: [], questions: [] },
      routing: { strategy: "single", agentId },
    });
    const id = m.json().mission.id;
    await c.request("POST", `/v1/missions/${id}/plans/1/approve`);
    let stop: { payload: Record<string, unknown> } | undefined;
    for (let i = 0; i < 100 && !stop; i++) {
      stop = (await readEventsSince(h.db.db, id, 0, 1000)).find((e) => e.type === "budget.stop");
      if (!stop) await new Promise((r) => setTimeout(r, 100));
    }
    expect(stop?.payload).toMatchObject({ scope: "workspace", scopeId: workspaceId, limitUsd: 0.01 });
    // The stop is announced as dispatch refuses; the task is blocked a moment later.
    let t: typeof schema.tasks.$inferSelect | undefined;
    for (let i = 0; i < 100; i++) {
      [t] = await h.db.db
        .select()
        .from(schema.tasks)
        .where(and(eq(schema.tasks.missionId, id), gt(schema.tasks.planVersion, 0)));
      if (t?.status === "blocked") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(t?.status).toBe("blocked");
    expect(t?.blockedReason).toContain("workspace's monthly budget");
    const ledger = await h.db.db
      .select()
      .from(schema.ledger)
      .where(eq(schema.ledger.workspaceId, workspaceId));
    expect(ledger.some((l) => l.kind === "policy.change")).toBe(true);
  }, 30_000);
});
