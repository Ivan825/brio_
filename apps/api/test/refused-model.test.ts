// A vendor that refuses the agent itself — a model it no longer serves to new users, a rejected key — fails every
// retry the same way. Planning moves on to another agent; with none left it stops and says what to change, and
// resumes once the agent has a model the vendor serves. Needs Postgres (planning runs no sandbox).
import { readEventsSince, schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT_REFUSED } from "../src/orchestrator/orchestrator";
import { Client, type Harness, startHarness } from "./helpers";
import { ScriptedVendors } from "./vendors";

const OPENAI_KEY = ["sk", "proj", "refused0123456789abcdefgh"].join("-");
const ANTHROPIC_KEY = ["sk", "ant", "api03", "refused0123456789abcdefgh"].join("-");
const RETIRED = "retired-model";
const PLAN = {
  assumptions: [],
  questions: [],
  tasks: [
    {
      key: "write.readme",
      type: "write.doc",
      title: "Write the README",
      contract: {
        objective: "A short README with a usage example",
        inputs: [],
        outputs: [{ kind: "report", description: "the README" }],
        acceptance: [{ kind: "human", hard: true }],
        constraints: [],
        sensitivity: "internal",
      },
      dependsOn: [],
      suggestedMode: "single",
      estimate: { usd: 0.01, minutes: 1 },
    },
  ],
};

describe("AGENT_REFUSED", () => {
  it("matches the vendor refusing the agent, not a failure of the work", () => {
    expect(AGENT_REFUSED.test("failed: not_found: 404: This model models/x is no longer available")).toBe(
      true,
    );
    expect(AGENT_REFUSED.test("failed: auth: 401: invalid key")).toBe(true);
    expect(AGENT_REFUSED.test("failed: rate_limited: 429")).toBe(false);
    expect(AGENT_REFUSED.test("failed: the planner did not finish")).toBe(false);
    expect(AGENT_REFUSED.test("timed_out")).toBe(false);
  });
});

describe.skipIf(!hasTestDatabase)("planning past a model the vendor refuses", () => {
  const vendors = new ScriptedVendors(() => ({
    text: `Here is the plan.\n\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\``,
  }));
  // The retired model answers 404, as Gemini does for a model it no longer serves to new users.
  const fetch = async (input: string | URL, init: RequestInit = {}) => {
    if (typeof init.body === "string" && init.body.includes(`"model":"${RETIRED}"`))
      return new Response(
        JSON.stringify({ error: { message: `This model ${RETIRED} is no longer available to new users.` } }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    return vendors.fetch(input, init);
  };
  let h: Harness;
  let c: Client;
  let openai: string;
  let anthropic: string;
  const price = { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null };

  const agent = async (name: string, connectorId: string, model: string) => {
    const r = await c.request("POST", "/v1/agents", { connectorId, name, model, priceOverride: price });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().agent.id as string;
  };
  const mission = async (goal: string, plannerAgentId?: string) => {
    const r = await c.request("POST", "/v1/missions", {
      goal,
      ...(plannerAgentId ? { plannerAgentId } : {}),
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().mission.id as string;
  };
  const waitFor = async (missionId: string, done: (m: typeof schema.missions.$inferSelect) => boolean) => {
    const until = Date.now() + 60_000;
    for (;;) {
      const [m] = await h.db.db.select().from(schema.missions).where(eq(schema.missions.id, missionId));
      if (m && done(m)) return m;
      if (Date.now() > until) {
        const tried = await h.db.db
          .select({
            status: schema.attempts.status,
            exitReason: schema.attempts.exitReason,
            model: sql`${schema.attempts.dispatch}->'agent'->>'model'`,
            created: schema.attempts.createdAt,
            blocked: schema.tasks.blockedReason,
          })
          .from(schema.attempts)
          .innerJoin(schema.tasks, eq(schema.tasks.id, schema.attempts.taskId))
          .where(eq(schema.tasks.missionId, missionId));
        throw new Error(`mission is ${m?.status}: ${m?.blockedReason}; attempts: ${JSON.stringify(tried)}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  const plannerAttempts = async (missionId: string) => {
    const events = await readEventsSince(h.db.db, missionId, 0, 1000);
    return events
      .filter((e) => e.type === "attempt.finished")
      .map((e) => (e.payload as { status: string; exitReason?: string }).status);
  };

  beforeAll(async () => {
    h = await startHarness({ fetch });
    c = new Client(h);
    await c.signIn("refused@example.com");
    await c.request("POST", "/v1/workspaces", { name: "Refused" });
    openai = (
      await c.request("POST", "/v1/connectors", { registryKey: "openai-api", apiKey: OPENAI_KEY })
    ).json().connector.id;
    anthropic = (
      await c.request("POST", "/v1/connectors", { registryKey: "claude-api", apiKey: ANTHROPIC_KEY })
    ).json().connector.id;
  });
  afterAll(async () => h?.close());

  it("stops with what to change when the only planner is refused, and resumes once its model is changed", {
    timeout: 90_000,
  }, async () => {
    const old = await agent("old", openai, RETIRED);
    const id = await mission("Write a short README for a to-do app");
    const blocked = await waitFor(id, (m) => Boolean(m.blockedReason?.includes("refused")));
    expect(blocked.blockedReason).toContain(`old (${RETIRED})`);
    expect(blocked.blockedReason).toContain("no longer available");
    expect(blocked.blockedReason).toContain("choose another model");
    // One refusal, not a retry per planning revision.
    expect(await plannerAttempts(id)).toEqual(["failed"]);

    const patched = await c.request("PATCH", `/v1/agents/${old}`, { model: "planner" });
    expect(patched.statusCode, patched.body).toBe(200);
    await waitFor(id, (m) => m.status === "awaiting_approval");
    expect(await plannerAttempts(id)).toEqual(["failed", "succeeded"]);
  });

  it("moves on to another agent at once when one is refused", { timeout: 90_000 }, async () => {
    const broken = await agent("broken", openai, RETIRED);
    await agent("writer", anthropic, "claude-writer");
    const id = await mission("Write a short README for a notes app", broken);
    await waitFor(id, (m) => m.status === "awaiting_approval");
    expect(await plannerAttempts(id)).toEqual(["failed", "succeeded"]);
    const [planning] = await h.db.db.select().from(schema.tasks).where(eq(schema.tasks.missionId, id));
    expect(planning?.revisions).toBe(0);
  });
});
