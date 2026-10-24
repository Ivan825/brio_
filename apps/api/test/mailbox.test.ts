// M3 acceptance: an agent's ask_agent question reaches the agent on another running task, and the answer comes back;
// the whole exchange is on the event trail. Two model-API agents, two vendors, no sandbox needed.
import { readEventsSince, schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";
import { type Reply, ScriptedVendors, taskTitle } from "./vendors";

const doc = (key: string, title: string) => ({
  key,
  type: "write.doc",
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
  tasks: [doc("backend.notes", "Write the backend notes"), doc("frontend.notes", "Write the frontend notes")],
  assumptions: [],
  questions: [],
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function script(call: { model: string; body: string; turn: number }): Promise<Reply> {
  if (call.model === "planner") return { text: `\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\`` };
  const title = taskTitle(call.body);
  if (title === "Write the frontend notes") {
    if (call.turn === 1)
      return {
        tools: [
          {
            name: "ask_agent",
            args: { task_key: "backend.notes", question: "Which port does the API listen on?" },
          },
        ],
      };
    const answer = /backend\.notes answered: ([^"\\]+)/.exec(call.body)?.[1] ?? "no answer";
    return { text: `The frontend calls the API on ${answer.trim()}.` };
  }
  if (title === "Write the backend notes") {
    const q = /message ([0-9a-f-]{36}) \(question from frontend\.notes\)/i.exec(call.body);
    if (q && !call.body.includes('"answered"'))
      return { tools: [{ name: "answer", args: { message_id: q[1], text: "port 4000" } }] };
    if (call.body.includes("answered")) return { text: "The API listens on port 4000." };
    await sleep(300);
    return { tools: [{ name: "report_progress", args: { note: "waiting for questions" } }] };
  }
  return { text: "?" };
}

describe.skipIf(!hasTestDatabase)("M3 acceptance: agents talk through the mailbox", () => {
  const vendors = new ScriptedVendors(script);
  let h: Harness;
  let c: Client;

  beforeAll(async () => {
    h = await startHarness({ fetch: vendors.fetch });
    c = new Client(h);
    await c.signIn("mailbox@example.com");
    await c.request("POST", "/v1/workspaces", { name: "Mailbox" });
  });
  afterAll(async () => h?.close());

  it("routes a question to the other running task and brings the answer back", async () => {
    const openai = (
      await c.request("POST", "/v1/connectors", {
        registryKey: "openai-api",
        apiKey: ["sk", "mailbox0123456789abcdef"].join("-"),
      })
    ).json().connector;
    const anthropic = (
      await c.request("POST", "/v1/connectors", {
        registryKey: "claude-api",
        apiKey: ["sk", "ant", "mailbox0123456789abcdef"].join("-"),
      })
    ).json().connector;
    const price = { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null };
    const mk = async (name: string, connectorId: string, model: string) =>
      (await c.request("POST", "/v1/agents", { connectorId, name, model, priceOverride: price })).json().agent
        .id as string;
    const planner = await mk("planner", openai.id, "planner");
    const front = await mk("front", openai.id, "gpt-coder");
    const back = await mk("back", anthropic.id, "claude-writer");

    const missionId = (
      await c.request("POST", "/v1/missions", {
        goal: "Write notes for both halves",
        plannerAgentId: planner,
      })
    ).json().mission.id;
    let plan: { version: number } | undefined;
    for (let i = 0; i < 200 && !plan; i++) {
      plan = (await c.request("GET", `/v1/missions/${missionId}/plans`)).json().plans[0];
      if (!plan) await sleep(100);
    }
    const edited = await c.request("POST", `/v1/missions/${missionId}/plans/${plan!.version}/edits`, {
      edits: [
        { op: "pin", key: "frontend.notes", agentId: front },
        { op: "pin", key: "backend.notes", agentId: back },
      ],
    });
    await c.request("POST", `/v1/missions/${missionId}/plans/${edited.json().plan.version}/approve`);

    for (let i = 0; i < 600; i++) {
      const [m] = await h.db.db.select().from(schema.missions).where(eq(schema.missions.id, missionId));
      if (m?.status === "done" || m?.status === "failed") break;
      await sleep(100);
    }
    const [m] = await h.db.db.select().from(schema.missions).where(eq(schema.missions.id, missionId));
    expect(m?.status, m?.blockedReason ?? "").toBe("done");

    const events = await readEventsSince(h.db.db, missionId, 0, 10_000);
    const sent = events.find((e) => e.type === "message.sent");
    const answered = events.find((e) => e.type === "message.answered");
    expect(sent?.payload).toMatchObject({
      kind: "question",
      from: "frontend.notes",
      to: "backend.notes",
      body: "Which port does the API listen on?",
    });
    expect(answered?.payload).toMatchObject({ from: "backend.notes", body: "port 4000" });
    expect(sent!.seq).toBeLessThan(answered!.seq);
    const finalFront = events
      .filter(
        (e) =>
          e.type === "attempt.message" &&
          (e.payload as { text: string }).text.startsWith("The frontend calls"),
      )
      .at(-1);
    expect((finalFront?.payload as { text?: string } | undefined)?.text).toBe(
      "The frontend calls the API on port 4000.",
    );

    const msgs = (await c.request("GET", `/v1/missions/${missionId}/messages`)).json().messages as {
      kind: string;
      status: string;
    }[];
    expect(msgs.map((x) => `${x.kind}:${x.status}`)).toEqual(["question:answered", "answer:open"]);
  }, 180_000);
});
