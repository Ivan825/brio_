// M8 (PRD F5): templates — a plan saved as a reusable pipeline. Saved from a mission's plan, a new mission starts from it
// as is (its plan v1, pins to deleted agents dropped) or adapted (the planner keeps its shape for the new goal).
// Needs Postgres.
import { schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";
import { type CallInfo, ScriptedVendors } from "./vendors";

const OPENAI_KEY = ["sk", "proj", "templates0123456789abcdef"].join("-");

const doc = (key: string, type: string, title: string, dependsOn: string[] = []) => ({
  key,
  type,
  title,
  contract: {
    objective: title,
    inputs: [],
    outputs: [{ kind: "doc", description: title }],
    acceptance: [{ kind: "rubric_review", hard: true, criteria: ["clear"] }],
    constraints: [],
    sensitivity: "internal",
  },
  dependsOn,
  suggestedMode: "single",
});

describe.skipIf(!hasTestDatabase)("M8: templates", () => {
  const plannerCalls: string[] = [];
  const vendors = new ScriptedVendors((call: CallInfo) => {
    if (!call.body.includes("# Plan this mission")) return { text: "ok" };
    plannerCalls.push(call.body);
    const plan = {
      tasks: [
        doc("research", "research.web", "Research solar"),
        doc("memo", "write.doc", "Solar memo", ["research"]),
      ],
      assumptions: [],
      questions: [],
    };
    return { text: `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` };
  });
  let h: Harness;
  let c: Client;
  let writer: string;
  let planner: string;
  let templateId: string;

  beforeAll(async () => {
    h = await startHarness({ fetch: vendors.fetch });
    c = new Client(h);
    await c.signIn("templates@example.com");
    await c.request("POST", "/v1/workspaces", { name: "Templates" });
    const openai = (
      await c.request("POST", "/v1/connectors", { registryKey: "openai-api", apiKey: OPENAI_KEY })
    ).json().connector;
    const price = { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null };
    const mk = async (name: string, model: string) =>
      (
        await c.request("POST", "/v1/agents", { connectorId: openai.id, name, model, priceOverride: price })
      ).json().agent.id as string;
    writer = await mk("writer", "gpt-w");
    planner = await mk("planner", "gpt-p");
  });
  afterAll(async () => {
    await h?.close();
  });

  it("saves a mission's plan as a template", async () => {
    const plan = {
      tasks: [
        doc("research", "research.web", "Research wind power"),
        { ...doc("memo", "write.doc", "Wind memo", ["research"]), pinnedAgentId: writer },
      ],
      assumptions: ["readers are investors"],
      questions: ["Which market?"],
    };
    const m = await c.request("POST", "/v1/missions", { goal: "Wind memo", plan });
    const res = await c.request("POST", "/v1/templates", {
      name: "Research → memo",
      fromMission: { missionId: m.json().mission.id },
    });
    expect(res.statusCode, res.body).toBe(201);
    templateId = res.json().template.id;
    expect(res.json().template).toMatchObject({
      name: "Research → memo",
      tasks: [
        { key: "research", type: "research.web" },
        { key: "memo", type: "write.doc", dependsOn: ["research"] },
      ],
    });
    expect(res.json().template.graph.questions).toEqual([]);
    expect((await c.request("GET", "/v1/templates")).json().templates).toHaveLength(1);
  });

  it("starts a mission from it as is; a pin to a deleted agent is dropped", async () => {
    expect((await c.request("DELETE", `/v1/agents/${writer}`)).statusCode).toBeLessThan(300);
    const m = await c.request("POST", "/v1/missions", {
      goal: "Same again",
      template: { id: templateId, mode: "as_is" },
    });
    expect(m.statusCode, m.body).toBe(201);
    expect(m.json().mission.status).toBe("awaiting_approval");
    const [p] = await h.db.db
      .select()
      .from(schema.plans)
      .where(eq(schema.plans.missionId, m.json().mission.id))
      .orderBy(desc(schema.plans.version));
    expect(p?.origin).toBe("template");
    expect(p?.graph.tasks.map((t) => t.title)).toEqual(["Research wind power", "Wind memo"]);
    expect(p?.graph.tasks.every((t) => !t.pinnedAgentId)).toBe(true);
  });

  it("adapted, the planner gets the template's shape for the new goal", async () => {
    const m = await c.request("POST", "/v1/missions", {
      goal: "A memo on solar power",
      plannerAgentId: planner,
      template: { id: templateId },
    });
    expect(m.statusCode, m.body).toBe(201);
    const id = m.json().mission.id;
    for (let i = 0; i < 200; i++) {
      const [row] = await h.db.db.select().from(schema.missions).where(eq(schema.missions.id, id));
      if (row?.status === "awaiting_approval") break;
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(plannerCalls.at(-1)).toContain("## Template: Research → memo");
    expect(plannerCalls.at(-1)).toContain("Research wind power");
    expect(plannerCalls.at(-1)).toContain("A memo on solar power");
    expect((await c.request("GET", `/v1/missions/${id}`)).json().plan.graph.tasks[1].title).toBe(
      "Solar memo",
    );
  });

  it("refuses a template and a plan together, and a deleted template", async () => {
    const both = await c.request("POST", "/v1/missions", {
      goal: "x",
      template: { id: templateId },
      plan: { tasks: [doc("a", "write.doc", "A")], assumptions: [], questions: [] },
    });
    expect(both.json().error).toBe("template_and_plan");
    expect((await c.request("DELETE", `/v1/templates/${templateId}`)).statusCode).toBe(204);
    expect(
      (await c.request("POST", "/v1/missions", { goal: "x", template: { id: templateId } })).statusCode,
    ).toBe(404);
  });
});
