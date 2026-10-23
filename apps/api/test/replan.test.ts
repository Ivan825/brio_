// M5 (verdict logic, last step): when a task fails for good, the planner proposes a revised plan once; on approval the
// finished tasks it kept unchanged carry their work over (no new attempts, handoffs to the new tasks), and the mission
// finishes. Needs Postgres.
import { readEventsSince, schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";
import { type CallInfo, type Reply, ScriptedVendors, taskTitle } from "./vendors";

const OPENAI_KEY = ["sk", "proj", "replan0123456789abcdefghi"].join("-");

const task = (key: string, title: string, acceptance: object[], dependsOn: string[] = []) => ({
  key,
  type: "write.doc",
  title,
  contract: {
    objective: title,
    inputs: [],
    outputs: [{ kind: "doc", description: title }],
    acceptance,
    constraints: [],
    sensitivity: "internal",
  },
  dependsOn,
  suggestedMode: "single",
  estimate: { usd: 0.01, minutes: 1 },
});
const intro = task("intro", "Write the intro", [{ kind: "citation_present", hard: true }]);
const PLAN_V1 = {
  tasks: [intro, task("outro", "Write the outro", [{ kind: "human", hard: true }], ["intro"])],
  assumptions: [],
  questions: [],
};
const PLAN_V2 = {
  tasks: [
    intro,
    task("outro.short", "Write a short outro", [{ kind: "citation_present", hard: true }], ["intro"]),
  ],
  assumptions: ["the long outro was rejected"],
  questions: [],
};

function script(call: CallInfo): Reply {
  const { body } = call;
  if (body.includes("# Plan this mission")) {
    const replanning = body.includes("## Replanning") && body.includes("task outro");
    return { text: `\`\`\`json\n${JSON.stringify(replanning ? PLAN_V2 : PLAN_V1)}\n\`\`\`` };
  }
  switch (taskTitle(body)) {
    case "Write the intro":
      return { text: "Brio conducts agents.\n\n## Decisions\n- Keep it short\n" };
    case "Write the outro":
      return { text: "A very long outro nobody wants." };
    case "Write a short outro":
      return { text: body.includes("Keep it short") ? "Thanks for reading." : "MISSING HANDOFF" };
    default:
      return { text: `unexpected: ${taskTitle(body)}` };
  }
}

describe.skipIf(!hasTestDatabase)(
  "M5: a failed task leads to a revised plan that keeps finished work",
  () => {
    const vendors = new ScriptedVendors(script);
    let h: Harness;
    let c: Client;
    let missionId: string;
    let writer: string;

    beforeAll(async () => {
      h = await startHarness({ fetch: vendors.fetch });
      c = new Client(h);
      await c.signIn("replan@example.com");
      await c.request("POST", "/v1/workspaces", { name: "Replan" });
      const openai = (
        await c.request("POST", "/v1/connectors", { registryKey: "openai-api", apiKey: OPENAI_KEY })
      ).json().connector;
      const r = await c.request("POST", "/v1/agents", {
        connectorId: openai.id,
        name: "writer",
        model: "planner",
        priceOverride: { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null },
      });
      writer = r.json().agent.id;
    });
    afterAll(async () => h?.close());

    const mission = async () =>
      (await h.db.db.select().from(schema.missions).where(eq(schema.missions.id, missionId)))[0]!;
    const waitFor = async (what: string, ok: () => Promise<boolean>, ms = 60_000) => {
      const until = Date.now() + ms;
      while (!(await ok())) {
        if (Date.now() > until)
          throw new Error(`timed out waiting for ${what}: mission ${(await mission()).status}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    const latestPlan = async () =>
      (await c.request("GET", `/v1/missions/${missionId}/plans`)).json().plans.at(-1) as {
        version: number;
        status: string;
        origin: string;
        graph: typeof PLAN_V1;
      };

    it("runs plan v1 until a person fails the outro", async () => {
      missionId = (
        await c.request("POST", "/v1/missions", { goal: "Write a page", plannerAgentId: writer })
      ).json().mission.id;
      await waitFor("plan v1", async () => (await mission()).status === "awaiting_approval");
      expect((await c.request("POST", `/v1/missions/${missionId}/plans/1/approve`)).statusCode).toBe(200);
      let outro: typeof schema.tasks.$inferSelect | undefined;
      // Waiting for review means verifying with a check only a person can decide (the checklist lands just after
      // the status does).
      await waitFor("the outro to wait for review", async () => {
        [outro] = await h.db.db
          .select()
          .from(schema.tasks)
          .where(and(eq(schema.tasks.missionId, missionId), eq(schema.tasks.key, "outro")));
        if (outro?.status !== "verifying") return false;
        const tried = await h.db.db
          .select()
          .from(schema.attempts)
          .where(eq(schema.attempts.taskId, outro.id));
        return tried.some((a) =>
          ((a.checks as { items?: { status: string }[] } | null)?.items ?? []).some(
            (i) => i.status === "needs_human",
          ),
        );
      });
      const r = await c.request("POST", `/v1/tasks/${outro!.id}/review`, {
        verdict: "fail",
        reasons: "too long",
      });
      expect(r.statusCode, r.body).toBe(200);
    });

    it("asks the planner for a revised plan that knows what failed and what is done", async () => {
      await waitFor("the revised plan", async () => (await mission()).status === "awaiting_approval");
      const plan = await latestPlan();
      expect(plan.version).toBe(2);
      expect(plan.origin).toBe("replan");
      expect(plan.graph.tasks.map((t) => t.key)).toEqual(["intro", "outro.short"]);
      const events = await readEventsSince(h.db.db, missionId, 0, 10_000);
      const replanning = events.find((e) => e.type === "mission.replanning")?.payload as {
        failedTask: string;
        keep: string[];
      };
      expect(replanning).toMatchObject({ failedTask: "outro", keep: ["intro"] });
      expect(events.some((e) => e.type === "mission.failed")).toBe(false);
    });

    it("carries the intro over on approval and finishes with the new outro", async () => {
      expect((await c.request("POST", `/v1/missions/${missionId}/plans/2/approve`)).statusCode).toBe(200);
      await waitFor("the mission to finish", async () => (await mission()).status === "done");
      const v2 = await h.db.db
        .select()
        .from(schema.tasks)
        .where(and(eq(schema.tasks.missionId, missionId), eq(schema.tasks.planVersion, 2)));
      const intro2 = v2.find((t) => t.key === "intro")!;
      expect(intro2.status).toBe("done");
      expect((intro2.modeParams as { carriedFrom?: string }).carriedFrom).toBeTruthy();
      // No new attempt for the carried task; the new outro got the intro's handoff (with its decision).
      expect(
        await h.db.db.select().from(schema.attempts).where(eq(schema.attempts.taskId, intro2.id)),
      ).toHaveLength(0);
      const outro2 = v2.find((t) => t.key === "outro.short")!;
      const handoffs = await h.db.db
        .select()
        .from(schema.handoffs)
        .where(eq(schema.handoffs.toTaskId, outro2.id));
      expect(handoffs.map((x) => x.packet.from.taskKey)).toEqual(["intro"]);
      const [answer] = await h.db.db
        .select()
        .from(schema.attempts)
        .where(eq(schema.attempts.taskId, outro2.id));
      expect(answer?.status).toBe("succeeded");
      const events = await readEventsSince(h.db.db, missionId, 0, 10_000);
      const said = events.find((e) => e.type === "attempt.message" && e.attemptId === answer?.id)
        ?.payload as {
        text?: string;
      };
      expect(said?.text).toBe("Thanks for reading.");
      expect(
        events
          .filter((e) => e.type === "plan.approved")
          .map((e) => (e.payload as { carried?: string[] }).carried),
      ).toEqual([undefined, ["intro"]]);
    });
  },
);
