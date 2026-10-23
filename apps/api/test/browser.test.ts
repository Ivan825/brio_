// M6 (browser agents) end to end: a computer-use agent's attempt runs in the browser sandbox (browser image, egress
// only to the task's sites), the browser really starts, the model's actions run there, and the final screen comes back.
// Needs Postgres and Docker.
import { schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { dockerAvailable } from "@brio/runner";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";

const hasDocker = await dockerAvailable();
const KEY = ["sk", "ant", "test", "0123456789abcdefghijklmnop"].join("-");

function anthropic() {
  const bodies: Array<Record<string, unknown>> = [];
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const fetch = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.host !== "api.anthropic.com") return json({}, 404);
    if ((init.headers as Record<string, string>)["x-api-key"] !== KEY)
      return json({ error: { type: "authentication_error" } }, 401);
    if (url.pathname === "/v1/models") return json({ data: [] });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    bodies.push(body);
    // First a screenshot, then the answer.
    if (bodies.length === 1)
      return json({
        id: "msg_1",
        content: [{ type: "tool_use", id: "t1", name: "screenshot", toolset_name: "computer", input: {} }],
        stop_reason: "tool_use",
        usage: { input_tokens: 5000, output_tokens: 50 },
      });
    return json({
      id: "msg_2",
      content: [{ type: "text", text: "The page shows the example domain notice." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 6500, output_tokens: 40 },
    });
  };
  return { fetch, bodies };
}

describe.skipIf(!hasTestDatabase || !hasDocker)("browser agents through the API", () => {
  const vendor = anthropic();
  let h: Harness;
  let c: Client;
  let agentId: string;

  beforeAll(async () => {
    h = await startHarness({ fetch: vendor.fetch });
    c = new Client(h);
    await c.signIn("browser@example.com");
    await c.request("POST", "/v1/workspaces", { name: "Browser" });
    const conn = await c.request("POST", "/v1/connectors", {
      registryKey: "claude-computer-use",
      apiKey: KEY,
    });
    expect(conn.statusCode, conn.body).toBe(201);
    const a = await c.request("POST", "/v1/agents", {
      connectorId: conn.json().connector.id,
      name: "computer",
      model: "claude-sonnet-5-5",
      priceOverride: { inputPerM: 3, outputPerM: 15, cachedInputPerM: null, cacheWritePerM: null },
    });
    expect(a.statusCode, a.body).toBe(201);
    agentId = a.json().agent.id;
  }, 30 * 60_000);
  afterAll(async () => h?.close());

  it(
    "runs in the browser sandbox, reaching only the task's site, and brings back the final screen",
    async () => {
      const plan = {
        tasks: [
          {
            key: "look",
            type: "browser.task",
            title: "Read the example page",
            contract: {
              objective: "Open the page and say what it shows",
              inputs: [{ kind: "url", ref: "https://www.example.com/" }],
              outputs: [{ kind: "report", description: "what the page shows" }],
              acceptance: [{ kind: "human", hard: false }],
              constraints: [],
              sensitivity: "internal",
            },
            dependsOn: [],
            suggestedMode: "single",
          },
        ],
        assumptions: [],
        questions: [],
      };
      const m = await c.request("POST", "/v1/missions", {
        goal: "Read a page",
        plan,
        routing: { strategy: "single", agentId },
      });
      expect(m.statusCode, m.body).toBe(201);
      const id = m.json().mission.id;
      expect((await c.request("POST", `/v1/missions/${id}/plans/1/approve`)).statusCode).toBe(200);
      const [task] = await h.db.db.select().from(schema.tasks).where(eq(schema.tasks.missionId, id));
      const until = Date.now() + 25 * 60_000;
      let attempt: typeof schema.attempts.$inferSelect | undefined;
      for (;;) {
        [attempt] = await h.db.db.select().from(schema.attempts).where(eq(schema.attempts.taskId, task!.id));
        if (attempt && ["succeeded", "failed", "cancelled"].includes(attempt.status)) break;
        if (Date.now() > until) throw new Error(`attempt still ${attempt?.status}`);
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(attempt?.status, attempt?.exitReason ?? "").toBe("succeeded");
      const dispatch = attempt?.dispatch as {
        image: string;
        sandbox: { profile: string; network: { mode: string; hosts?: string[] }; worktree: string };
      };
      expect(dispatch.image).toBe("browser");
      expect(dispatch.sandbox).toMatchObject({
        profile: "browser",
        worktree: "ro",
        network: { mode: "allowlist", hosts: [".example.com", "example.com", "www.example.com"] },
      });
      // The model saw a real screenshot of the sandbox's browser.
      const second = vendor.bodies[1] as { messages: Array<{ content: unknown }> };
      const shot = JSON.stringify(second.messages.at(-1)?.content);
      expect(shot).toContain('"media_type":"image/png"');
      const arts = await h.db.db
        .select()
        .from(schema.artifacts)
        .where(eq(schema.artifacts.attemptId, attempt!.id));
      expect(arts.map((a) => a.kind)).toContain("image");
      expect(attempt?.costUsd).toBeCloseTo((11_500 * 3 + 90 * 15) / 1e6, 6);
    },
    30 * 60_000,
  );
});
