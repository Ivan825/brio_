// M8 (PRD glossary: Crew): a saved set of agents and preferences. A mission routed to a crew uses only the crew's agents,
// and the crew's agent for a task type unless the plan pins another. Needs Postgres.
import { schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";
import { ScriptedVendors } from "./vendors";

const OPENAI_KEY = ["sk", "proj", "crews0123456789abcdefghij"].join("-");
const ANTHROPIC_KEY = ["sk", "ant", "api03", "crews0123456789abcdefghij"].join("-");

const doc = (key: string, type: string, title: string) => ({
  key,
  type,
  title,
  contract: {
    objective: title,
    inputs: [],
    outputs: [{ kind: "doc", description: title }],
    acceptance: [{ kind: "diff_scope", hard: true }],
    constraints: [],
    sensitivity: "internal",
  },
  dependsOn: [],
  suggestedMode: "single",
});
const PLAN = {
  tasks: [doc("spec", "write.doc", "Write the spec"), doc("tldr", "write.summary", "Summarise it")],
  assumptions: [],
  questions: [],
};

describe.skipIf(!hasTestDatabase)("M8: crews", () => {
  let h: Harness;
  let c: Client;
  const agent: Record<string, string> = {};
  let crewId: string;

  beforeAll(async () => {
    // Connector checks answer from the script; no attempt runs (no runner), so routing is all that is tested.
    h = await startHarness({ runner: false, fetch: new ScriptedVendors(() => ({ text: "ok" })).fetch });
    c = new Client(h);
    await c.signIn("crews@example.com");
    await c.request("POST", "/v1/workspaces", { name: "Crews" });
    const openai = (
      await c.request("POST", "/v1/connectors", { registryKey: "openai-api", apiKey: OPENAI_KEY })
    ).json().connector;
    const anthropic = (
      await c.request("POST", "/v1/connectors", { registryKey: "claude-api", apiKey: ANTHROPIC_KEY })
    ).json().connector;
    const price = { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null };
    for (const [name, connectorId, model] of [
      ["alpha", openai.id, "gpt-a"],
      ["beta", anthropic.id, "claude-b"],
      ["gamma", openai.id, "gpt-c"],
    ] as const)
      agent[name] = (
        await c.request("POST", "/v1/agents", { connectorId, name, model, priceOverride: price })
      ).json().agent.id;
  });
  afterAll(async () => {
    await h?.close();
  });

  it("saves a crew of the workspace's agents, with pins only to its own members", async () => {
    const outside = await c.request("POST", "/v1/crews", {
      name: "Writers",
      agentIds: [agent.alpha, agent.beta],
      pins: { "write.doc": agent.gamma },
    });
    expect(outside.json().error).toBe("pin_outside_crew");
    const made = await c.request("POST", "/v1/crews", {
      name: "Writers",
      agentIds: [agent.alpha, agent.beta],
      pins: { "write.doc": agent.beta },
    });
    expect(made.statusCode, made.body).toBe(201);
    crewId = made.json().crew.id;
    expect(made.json().crew).toMatchObject({ name: "Writers", pins: { "write.doc": agent.beta } });
    expect((await c.request("GET", "/v1/crews")).json().crews).toHaveLength(1);
  });

  it("routes a crew's mission to its agents only, and its pinned agent for the pinned type", async () => {
    const m = await c.request("POST", "/v1/missions", {
      goal: "Docs",
      plan: PLAN,
      routing: { strategy: "crew", crewId },
    });
    expect(m.statusCode, m.body).toBe(201);
    const id = m.json().mission.id;
    expect((await c.request("POST", `/v1/missions/${id}/plans/1/approve`)).statusCode).toBe(200);
    let rows: Array<{ key: string; agentId: string | null }> = [];
    for (let i = 0; i < 100; i++) {
      rows = await h.db.db
        .select({ key: schema.tasks.key, agentId: schema.attempts.agentId })
        .from(schema.attempts)
        .innerJoin(schema.tasks, eq(schema.tasks.id, schema.attempts.taskId))
        .where(eq(schema.tasks.missionId, id));
      if (new Set(rows.map((r) => r.key)).size === 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const ts = await h.db.db.select().from(schema.tasks).where(eq(schema.tasks.missionId, id));
    expect(
      new Set(rows.map((r) => r.key)),
      ts.map((t) => `${t.key} ${t.status} ${t.blockedReason}`).join("\n"),
    ).toEqual(new Set(["spec", "tldr"]));
    for (const r of rows) expect([agent.alpha, agent.beta]).toContain(r.agentId);
    expect(rows.filter((r) => r.key === "spec").map((r) => r.agentId)).toEqual([agent.beta]);
  });

  it("refuses a deleted crew", async () => {
    expect((await c.request("DELETE", `/v1/crews/${crewId}`)).statusCode).toBe(204);
    const m = await c.request("POST", "/v1/missions", {
      goal: "Docs",
      routing: { strategy: "crew", crewId },
    });
    expect(m.json().error).toBe("unknown_crew");
  });
});
