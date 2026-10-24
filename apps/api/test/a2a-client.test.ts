// M7 acceptance: Brio delegates a task to an external A2A agent (a sample agent on the official SDK) and verifies its
// output. Installing the agent by URL reads its Agent Card, whose skills suggest the task types it takes; a research
// task goes to it, its cited answer passes the citation check, and a question it asks reaches the mission's person and
// the answer goes back. Needs Postgres.
import { schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { and, eq, gt } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSampleAgent } from "./a2a-sample-agent";
import { Client, type Harness, startHarness } from "./helpers";

const plan = (objective: string) => ({
  tasks: [
    {
      key: "research",
      type: "research.web",
      title: "Research orchestration",
      contract: {
        objective,
        inputs: [],
        outputs: [{ kind: "report", description: "a cited answer" }],
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

describe.skipIf(!hasTestDatabase)("M7: A2A agents as Brio workers", () => {
  let agent: Awaited<ReturnType<typeof startSampleAgent>>;
  let h: Harness;
  let c: Client;
  let agentId: string;

  beforeAll(async () => {
    agent = await startSampleAgent();
    // The sample agent is on this machine; Brio reaches it with the ordinary fetch.
    h = await startHarness({ fetch: (input, init) => fetch(input, init) });
    c = new Client(h);
    await c.signIn("a2a-client@example.com");
    await c.request("POST", "/v1/workspaces", { name: "Partners" });
  });
  afterAll(async () => {
    await h?.close();
    await agent?.close();
  });

  it("installs an A2A agent by URL: its card names it and its skills give its task types", async () => {
    const res = await c.request("POST", "/v1/connectors", {
      registryKey: "a2a-protocol",
      service: "a2a",
      settings: { url: agent.url },
    });
    expect(res.statusCode, res.body).toBe(201);
    const conn = res.json().connector;
    expect(conn).toMatchObject({
      service: "a2a",
      displayName: "Sample research agent",
      agentCard: { name: "Sample research agent", skills: [{ id: "research" }] },
    });
    expect(conn.health.ok).toBe(true);
    expect(conn.taskTypes).toEqual(["research.deep_report", "research.web"]);
    const a = await c.request("POST", "/v1/agents", {
      connectorId: conn.id,
      name: "partner",
      model: "agent",
    });
    expect(a.statusCode, a.body).toBe(201);
    agentId = a.json().agent.id;
    const listed = (await c.request("GET", "/v1/agents"))
      .json()
      .agents.find((x: { id: string }) => x.id === agentId);
    expect(listed.runnable).toBe(true);
  });

  const run = async (objective: string, onQuestion?: (id: string) => Promise<void>) => {
    const m = await c.request("POST", "/v1/missions", {
      goal: objective,
      plan: plan(objective),
      routing: { strategy: "single", agentId },
    });
    const id = m.json().mission.id as string;
    expect((await c.request("POST", `/v1/missions/${id}/plans/1/approve`)).statusCode).toBe(200);
    const answered = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const [row] = await h.db.db.select().from(schema.missions).where(eq(schema.missions.id, id));
      if (row?.status === "done" || row?.status === "failed") return { id, status: row.status };
      if (onQuestion) {
        const open = await h.db.db
          .select()
          .from(schema.messages)
          .where(
            and(
              eq(schema.messages.missionId, id),
              eq(schema.messages.toUser, true),
              eq(schema.messages.status, "open"),
            ),
          );
        for (const q of open)
          if (!answered.has(q.id)) {
            answered.add(q.id);
            await onQuestion(q.id);
          }
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("the mission did not finish");
  };

  it("delegates a task to the A2A agent and verifies its output", async () => {
    const { id, status } = await run("Explain what an agent orchestrator does, with a source");
    expect(status).toBe("done");
    const [task] = await h.db.db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.missionId, id), gt(schema.tasks.planVersion, 0)));
    const [attempt] = await h.db.db
      .select()
      .from(schema.attempts)
      .where(eq(schema.attempts.taskId, task!.id));
    const checks = attempt?.checks as { items: { kind: string; status: string }[] };
    expect(checks.items).toEqual([
      expect.objectContaining({ kind: "citation_present", status: "passed" }),
      expect.objectContaining({ kind: "injection_scan", status: "passed" }),
    ]);
    expect(attempt?.transcriptRef).toBeTruthy();
    const out = (await c.request("GET", `/v1/attempts/${attempt!.id}/output`)).body;
    expect(out).toContain("https://example.com/orchestration");
    expect(agent.executor.seen.at(-1)).toContain("Explain what an agent orchestrator does");
  }, 120_000);

  it("brings the agent's question to the person and the answer back to the agent", async () => {
    const { status } = await run("ASK: research orchestration adoption", async (qid) => {
      const r = await c.request("POST", `/v1/messages/${qid}/answer`, { text: "Europe" });
      expect(r.statusCode, r.body).toBe(201);
    });
    expect(status).toBe("done");
    expect(agent.executor.seen.at(-1)).toBe("Europe");
  }, 120_000);
});
