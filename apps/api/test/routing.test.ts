// Mission options the eval harness compares (M5): a supplied plan skips the planner; routing "static" uses the
// capability router without learning or modes; routing "single" gives one agent one shot (no revisions, no other
// agent, no revised plan). Needs Postgres.
import { readEventsSince, schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { and, eq, gt } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";
import { type CallInfo, type Reply, ScriptedVendors, taskTitle } from "./vendors";

const OPENAI_KEY = ["sk", "proj", "routing0123456789abcdefgh"].join("-");
const ANTHROPIC_KEY = ["sk", "ant", "api03", "routing0123456789abcdefgh"].join("-");

const LONG_UNCITED =
  "Brio routes every task to the agent most likely to pass its checks at the lowest cost, and it learns from each verdict which agents win at which kinds of work over time.";
const plan = (title: string) => ({
  tasks: [
    {
      key: "note",
      type: "write.doc",
      title,
      contract: {
        objective: title,
        inputs: [],
        outputs: [{ kind: "doc", description: title }],
        acceptance: [{ kind: "citation_present", hard: true }],
        constraints: [],
        sensitivity: "internal",
      },
      dependsOn: [],
      suggestedMode: "single",
    },
  ],
  assumptions: [],
  questions: [],
});

function script(call: CallInfo): Reply {
  if (call.body.includes("# Plan this mission")) return { text: "the planner should not be asked" };
  const revised = call.body.includes("Your previous attempt was sent back");
  switch (taskTitle(call.body)) {
    case "Write the cited note":
      return { text: revised ? `${LONG_UNCITED} [1]\n\n[1]: https://example.com/brio` : LONG_UNCITED };
    default:
      return { text: "Short and fine." };
  }
}

describe.skipIf(!hasTestDatabase)("mission routing strategies and supplied plans", () => {
  const vendors = new ScriptedVendors(script);
  let h: Harness;
  let c: Client;
  const agents: Record<string, string> = {};

  beforeAll(async () => {
    h = await startHarness({ fetch: vendors.fetch });
    c = new Client(h);
    await c.signIn("routing@example.com");
    await c.request("POST", "/v1/workspaces", { name: "Routing" });
    const openai = (
      await c.request("POST", "/v1/connectors", { registryKey: "openai-api", apiKey: OPENAI_KEY })
    ).json().connector;
    const anthropic = (
      await c.request("POST", "/v1/connectors", { registryKey: "claude-api", apiKey: ANTHROPIC_KEY })
    ).json().connector;
    const price = { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null };
    for (const [name, connectorId, model] of [
      ["gpt", openai.id, "gpt-coder"],
      ["claude", anthropic.id, "claude-writer"],
    ] as const)
      agents[name] = (
        await c.request("POST", "/v1/agents", { connectorId, name, model, priceOverride: price })
      ).json().agent.id;
  });
  afterAll(async () => h?.close());

  async function run(title: string, routing: unknown) {
    const res = await c.request("POST", "/v1/missions", {
      goal: title,
      plan: plan(title),
      routing,
      priority: "fast",
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().mission.id as string;
    expect(res.json().mission).toMatchObject({ status: "awaiting_approval", routing });
    const plans = (await c.request("GET", `/v1/missions/${id}/plans`)).json().plans;
    expect(plans.map((p: { origin: string }) => p.origin)).toEqual(["supplied"]);
    expect((await c.request("POST", `/v1/missions/${id}/plans/1/approve`)).statusCode).toBe(200);
    const until = Date.now() + 60_000;
    for (;;) {
      const [m] = await h.db.db.select().from(schema.missions).where(eq(schema.missions.id, id));
      if (m?.status === "done" || m?.status === "failed") break;
      if (Date.now() > until) throw new Error(`mission ${m?.status}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    const [task] = await h.db.db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.missionId, id), gt(schema.tasks.planVersion, 0)));
    const tried = await h.db.db.select().from(schema.attempts).where(eq(schema.attempts.taskId, task!.id));
    const events = await readEventsSince(h.db.db, id, 0, 10_000);
    const [m] = await h.db.db.select().from(schema.missions).where(eq(schema.missions.id, id));
    return { m: m!, task: task!, tried, events };
  }

  it("never asks a planner when the plan is supplied", () => {
    expect(vendors.calls.some((c) => c.body.includes("# Plan this mission"))).toBe(false);
  });

  it("single: one agent, one shot — a failed check fails the mission (no revision, no other agent, no replan)", async () => {
    const r = await run("Write the cited note", { strategy: "single", agentId: agents.claude });
    expect(r.tried).toHaveLength(1);
    expect(r.tried[0]?.agentId).toBe(agents.claude);
    expect(r.task.status).toBe("failed");
    expect(r.m.status).toBe("failed");
    expect(r.events.some((e) => e.type === "mission.replanning")).toBe(false);
  });

  it("learned (the default): the same failure is revised and fixed", async () => {
    const r = await run("Write the cited note", { strategy: "learned" });
    expect(r.tried).toHaveLength(2);
    expect(r.m.status).toBe("done");
  });

  it("static: the capability router picks, without modes or learning", async () => {
    const r = await run("Write a plain note", { strategy: "static" });
    expect(r.m.status).toBe("done");
    const routed = r.events.find((e) => e.type === "task.routed")?.payload as {
      mode: string;
      rationale: string;
    };
    expect(routed.mode).toBe("single");
    expect(routed.rationale).toMatch(/\(static routing\)$/);
  });

  it("refuses a single agent from another workspace", async () => {
    const res = await c.request("POST", "/v1/missions", {
      goal: "x",
      routing: { strategy: "single", agentId: "0192f000-0000-7000-8000-000000000999" },
    });
    expect(res.statusCode).toBe(422);
  });
});
