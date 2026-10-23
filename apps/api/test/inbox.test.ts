// M8: the approvals inbox. Everything in a workspace waiting for a person — a proposed plan, a question from an agent,
// an action awaiting a yes — in one list, oldest first, and nothing from another workspace. Needs Postgres.
import { schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";

const PLAN = {
  tasks: [
    {
      key: "copy",
      type: "write.marketing_copy",
      title: "Write the hero copy",
      contract: {
        objective: "Hero copy for the landing page",
        inputs: [],
        outputs: [{ kind: "doc", description: "the copy" }],
        acceptance: [{ kind: "diff_scope", hard: true }],
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

describe.skipIf(!hasTestDatabase)("M8: inbox", () => {
  let h: Harness;
  let c: Client;
  let other: Client;
  let workspaceId: string;
  let missionId: string;

  beforeAll(async () => {
    h = await startHarness();
    c = new Client(h);
    await c.signIn("inbox@example.com");
    workspaceId = (await c.request("POST", "/v1/workspaces", { name: "Inbox" })).json().workspace.id;
    other = new Client(h);
    await other.signIn("inbox-other@example.com");
    await other.request("POST", "/v1/workspaces", { name: "Elsewhere" });
  });
  afterAll(async () => {
    await h?.close();
  });

  it("is empty for a fresh workspace", async () => {
    const res = await c.request("GET", "/v1/inbox");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ items: [], count: 0 });
  });

  it("lists a proposed plan, a question for the user and a pending action, oldest first", async () => {
    const m = await c.request("POST", "/v1/missions", { goal: "Landing page copy", plan: PLAN });
    expect(m.statusCode, m.body).toBe(201);
    missionId = m.json().mission.id;
    await h.db.db.insert(schema.messages).values({
      workspaceId,
      missionId,
      toUser: true,
      kind: "question",
      body: "Which tone: playful or formal?",
    });
    await h.db.db.insert(schema.approvals).values({
      workspaceId,
      subjectKind: "mission",
      subjectId: missionId,
      action: "open_pr",
      requestedBy: "brio",
    });

    const res = await c.request("GET", "/v1/inbox");
    const { items, count } = res.json();
    expect(count).toBe(3);
    expect(items.map((i: { kind: string }) => i.kind)).toEqual(["plan", "question", "action"]);
    expect(items[0]).toMatchObject({ missionId, mission: "Landing page copy", version: 1 });
    expect(items[1]).toMatchObject({ missionId, body: "Which tone: playful or formal?" });
    expect(items[2]).toMatchObject({ missionId, action: "open_pr", requestedBy: "brio" });
  });

  it("drops a plan once it is approved, and shows another workspace nothing", async () => {
    expect((await other.request("GET", "/v1/inbox")).json().count).toBe(0);
    expect((await c.request("POST", `/v1/missions/${missionId}/plans/1/approve`)).statusCode).toBe(200);
    const kinds = (await c.request("GET", "/v1/inbox")).json().items.map((i: { kind: string }) => i.kind);
    expect(kinds).not.toContain("plan");
    expect(kinds).toContain("question");
  });
});
