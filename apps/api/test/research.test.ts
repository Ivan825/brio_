// M6 (research) through the API: a search connector is a tool, not an agent; attempts get the workspace's search tool
// (confidential tasks do not); a research agent answers a research task with a cited report that passes the citation
// check. Needs Postgres.
import { schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";

const TAVILY = ["tvly", "test", "0123456789abcdefghijklmnop"].join("-");
const OPENAI = ["sk", "test", "0123456789abcdefghijklmnop"].join("-");
const ANSWER = "Brio routes each task to the best agent [1]. It verifies results across vendors [2].";

function vendors() {
  const seen: string[] = [];
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const fetch = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const auth = (init.headers as Record<string, string>)?.authorization;
    seen.push(`${init.method ?? "GET"} ${url.host}${url.pathname}`);
    if (url.host === "api.tavily.com") {
      if (auth !== `Bearer ${TAVILY}`) return json({ detail: { error: "Unauthorized" } }, 401);
      if (url.pathname === "/usage") return json({ key: { usage: 0 } });
      return json({ results: [], usage: { credits: 1 } });
    }
    if (url.host === "api.openai.com") {
      if (auth !== `Bearer ${OPENAI}`) return json({ error: { message: "bad key" } }, 401);
      if (url.pathname === "/v1/models") return json({ data: [] });
      if (url.pathname === "/v1/responses" && init.method === "POST")
        return json({ id: "resp_1", status: "queued" });
      if (url.pathname === "/v1/responses/resp_1")
        return json({
          id: "resp_1",
          status: "completed",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: ANSWER,
                  annotations: [
                    { type: "url_citation", url: "https://brio.dev/route", title: "Routing" },
                    { type: "url_citation", url: "https://brio.dev/verify", title: "Verification" },
                  ],
                },
              ],
            },
          ],
          usage: { input_tokens: 1000, output_tokens: 200 },
        });
    }
    return json({}, 404);
  };
  return { fetch, seen };
}

const plan = (sensitivity: "internal" | "confidential") => ({
  tasks: [
    {
      key: "what",
      type: "research.web",
      title: "What Brio does",
      contract: {
        objective: "Explain what Brio does, citing sources",
        inputs: [],
        outputs: [{ kind: "report", description: "a short cited answer" }],
        acceptance: [{ kind: "citation_present", hard: true }],
        constraints: [],
        sensitivity,
      },
      dependsOn: [],
      suggestedMode: "single",
    },
  ],
  assumptions: [],
  questions: [],
});

describe.skipIf(!hasTestDatabase)("research through the API", () => {
  const v = vendors();
  let h: Harness;
  let c: Client;
  let agentId: string;

  beforeAll(async () => {
    h = await startHarness({ fetch: v.fetch });
    c = new Client(h);
    await c.signIn("research@example.com");
    await c.request("POST", "/v1/workspaces", { name: "Research" });
  });
  afterAll(async () => h?.close());

  it("installs a search connector as a tool: its key is checked, and no agent can be built on it", async () => {
    const res = await c.request("POST", "/v1/connectors", {
      registryKey: "exa-tavily-parallel",
      service: "tavily",
      apiKey: TAVILY,
    });
    expect(res.statusCode, res.body).toBe(201);
    const conn = res.json().connector;
    expect(conn).toMatchObject({ service: "tavily", serviceKind: "search" });
    expect(conn.health.ok).toBe(true);
    const a = await c.request("POST", "/v1/agents", { connectorId: conn.id, name: "tavily", model: "x" });
    expect(a.statusCode).toBe(422);
    expect(a.json().error).toBe("tool_connector");
  });

  it("installs a research agent", async () => {
    const res = await c.request("POST", "/v1/connectors", {
      registryKey: "openai-search-deep-research",
      apiKey: OPENAI,
    });
    expect(res.statusCode, res.body).toBe(201);
    const conn = res.json().connector;
    expect(conn).toMatchObject({ service: "openai-research", serviceKind: "research" });
    const a = await c.request("POST", "/v1/agents", {
      connectorId: conn.id,
      name: "researcher",
      model: "gpt-5.5",
      priceOverride: { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null },
    });
    expect(a.statusCode, a.body).toBe(201);
    agentId = a.json().agent.id;
  });

  const run = async (sensitivity: "internal" | "confidential") => {
    const m = await c.request("POST", "/v1/missions", {
      goal: "Explain Brio",
      plan: plan(sensitivity),
      routing: { strategy: "single", agentId },
    });
    expect(m.statusCode, m.body).toBe(201);
    const id = m.json().mission.id;
    expect((await c.request("POST", `/v1/missions/${id}/plans/1/approve`)).statusCode).toBe(200);
    const until = Date.now() + 60_000;
    for (;;) {
      const [row] = await h.db.db.select().from(schema.missions).where(eq(schema.missions.id, id));
      if (row?.status === "done" || row?.status === "failed") return { id, status: row.status };
      if (Date.now() > until) throw new Error(`mission still ${row?.status}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  it("answers a research task with a cited report, with the workspace's search tool attached", async () => {
    const { id, status } = await run("internal");
    expect(status).toBe("done");
    const [task] = await h.db.db.select().from(schema.tasks).where(eq(schema.tasks.missionId, id));
    const [attempt] = await h.db.db
      .select()
      .from(schema.attempts)
      .where(eq(schema.attempts.taskId, task!.id));
    const dispatch = attempt?.dispatch as { tools?: { search?: { connector: { serviceKey: string } } } };
    expect(dispatch.tools?.search?.connector.serviceKey).toBe("tavily");
    const checks = attempt?.checks as { items: { kind: string; status: string }[] };
    expect(checks.items).toEqual([
      expect.objectContaining({ kind: "citation_present", status: "passed" }),
      expect.objectContaining({ kind: "injection_scan", status: "passed" }),
    ]);
    // No credential is stored with the dispatch.
    expect(JSON.stringify(attempt?.dispatch)).not.toContain(TAVILY);
  });

  it("sends a confidential task to no third party: not to the research agent, not to search", async () => {
    const m = await c.request("POST", "/v1/missions", {
      goal: "Explain Brio",
      plan: plan("confidential"),
      routing: { strategy: "single", agentId },
    });
    const id = m.json().mission.id;
    expect((await c.request("POST", `/v1/missions/${id}/plans/1/approve`)).statusCode).toBe(200);
    const until = Date.now() + 20_000;
    let task: typeof schema.tasks.$inferSelect | undefined;
    for (;;) {
      [task] = await h.db.db.select().from(schema.tasks).where(eq(schema.tasks.missionId, id));
      if (task?.blockedReason || Date.now() > until) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(task?.blockedReason).toMatch(/^policy: .*confidential work goes only to local models/);
    const tried = await h.db.db.select().from(schema.attempts).where(eq(schema.attempts.taskId, task!.id));
    expect(tried).toEqual([]);
  });
});
