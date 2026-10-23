// M3 acceptance (written first): a golden-style mission is planned into four tasks including a contract task, edited,
// approved, and run as a graph with two vendors in parallel; leases never overlap; handoffs reach the dependent task;
// a command check runs in a sandbox; and killing the API mid-mission does not stop it: after a restart the mission
// completes. Needs Postgres and Docker (code tasks run in sandboxes).
import { readEventsSince, schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { dockerAvailable } from "@brio/runner";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";
import { type Reply, ScriptedVendors, taskTitle } from "./vendors";

const hasDocker = await dockerAvailable();
const OPENAI_KEY = ["sk", "proj", "orchestration0123456789ab"].join("-");
const ANTHROPIC_KEY = ["sk", "ant", "api03", "orchestration0123456789ab"].join("-");

const contractInput = { kind: "contract", ref: "contract.auth-api" };
const PLAN = {
  tasks: [
    {
      key: "contract.auth-api",
      type: "design.api_contract",
      title: "Define the auth API contract",
      contract: {
        objective: "Write the sign-in request and response shapes",
        inputs: [],
        outputs: [{ kind: "file", description: "the contract", path: "contracts/auth.md" }],
        acceptance: [{ kind: "diff_scope", hard: true }],
        constraints: [],
        expectedFootprint: { paths: ["contracts/**"] },
        sensitivity: "internal",
      },
      dependsOn: [],
      suggestedMode: "single",
      estimate: { usd: 0.01, minutes: 1 },
    },
    {
      key: "api.auth",
      type: "code.feature",
      title: "Add the OAuth callback route",
      contract: {
        objective: "Implement the callback per the contract, with a test",
        inputs: [contractInput],
        outputs: [{ kind: "diff", description: "route and test" }],
        acceptance: [
          { kind: "diff_scope", hard: true },
          { kind: "tests", command: "node --test 'api/*.test.mjs'", hard: true },
        ],
        constraints: [],
        expectedFootprint: { paths: ["api/**"] },
        sensitivity: "internal",
      },
      dependsOn: [],
      suggestedMode: "single",
      estimate: { usd: 0.02, minutes: 3 },
    },
    {
      key: "web.signin",
      type: "code.feature",
      title: "Add the sign-in button",
      contract: {
        objective: "Add a sign-in button that starts the OAuth flow",
        inputs: [contractInput],
        outputs: [{ kind: "diff", description: "the button" }],
        acceptance: [{ kind: "diff_scope", hard: true }],
        constraints: [],
        expectedFootprint: { paths: ["web/**"] },
        sensitivity: "internal",
      },
      dependsOn: [],
      suggestedMode: "single",
      estimate: { usd: 0.02, minutes: 3 },
    },
    {
      key: "docs.auth",
      type: "write.doc",
      title: "Document OAuth login",
      contract: {
        objective: "Explain how to sign in",
        inputs: [],
        outputs: [{ kind: "doc", description: "a short guide" }],
        acceptance: [{ kind: "diff_scope", hard: true }],
        constraints: [],
        sensitivity: "internal",
      },
      dependsOn: ["api.auth", "web.signin"],
      suggestedMode: "single",
      estimate: { usd: 0.01, minutes: 1 },
    },
  ],
  assumptions: ["The app has no auth yet"],
  questions: [],
};

/** Lets the test hold the sign-in task mid-run while it restarts the API. */
let releaseSignin: () => void = () => {};
const signinHeld = new Promise<void>((r) => {
  releaseSignin = r;
});

const write = (path: string, content: string): Reply => ({
  tools: [{ name: "write_file", args: { path, content } }],
});
const done = (text: string): Reply => ({ text });

async function script(call: { model: string; body: string; turn: number }): Promise<Reply> {
  if (call.model === "planner") return done(`Here is the plan.\n\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\``);
  const title = taskTitle(call.body);
  switch (title) {
    case "Define the auth API contract":
      return call.turn === 1
        ? write(
            "contracts/auth.md",
            "# Auth API\n\nGET /auth/callback?code=… → 302 to / with a session cookie.\n",
          )
        : done("Defined the callback contract.\n\n## Decisions\n- Sessions are cookies\n");
    case "Add the OAuth callback route":
      if (call.turn === 1)
        return write(
          "api/callback.mjs",
          "export const callback = (code) => (code ? { status: 302 } : { status: 400 });\n",
        );
      if (call.turn === 2)
        return write(
          "api/callback.test.mjs",
          'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { callback } from "./callback.mjs";\ntest("redirects with a code", () => assert.equal(callback("x").status, 302));\n',
        );
      return done("Added the callback route with a test.\n\n## Decisions\n- 400 without a code\n");
    case "Add the sign-in button":
      if (call.turn === 1) {
        await signinHeld;
        return write("web/signin.html", '<a href="/auth/start">Sign in</a>\n');
      }
      return done("Added the sign-in button.\n");
    case "Document OAuth login":
      return done(
        call.body.includes("Sessions are cookies") && call.body.includes("untrusted content")
          ? "Sign in with the button; the callback sets a session cookie."
          : "MISSING HANDOFF",
      );
    default:
      return done(`unexpected request: ${title}`);
  }
}

describe.skipIf(!hasTestDatabase || !hasDocker)(
  "M3 acceptance: a planned mission runs as a graph and survives an API crash",
  () => {
    const vendors = new ScriptedVendors(script);
    let h: Harness;
    let c: Client;
    let missionId: string;
    const agents: Record<string, string> = {};

    beforeAll(async () => {
      h = await startHarness({ fetch: vendors.fetch });
      c = new Client(h);
      await c.signIn("conductor@example.com");
      await c.request("POST", "/v1/workspaces", { name: "Orchestra" });
      const openai = (
        await c.request("POST", "/v1/connectors", { registryKey: "openai-api", apiKey: OPENAI_KEY })
      ).json().connector;
      const anthropic = (
        await c.request("POST", "/v1/connectors", { registryKey: "claude-api", apiKey: ANTHROPIC_KEY })
      ).json().connector;
      const price = { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null };
      for (const [name, connectorId, model] of [
        ["planner", openai.id, "planner"],
        ["coder", openai.id, "gpt-coder"],
        ["writer", anthropic.id, "claude-writer"],
      ] as const) {
        const r = await c.request("POST", "/v1/agents", {
          connectorId,
          name,
          model,
          priceOverride: price,
          limits: { maxCostUsd: 1 },
        });
        expect(r.statusCode, r.body).toBe(201);
        agents[name] = r.json().agent.id;
      }
    });
    afterAll(async () => h?.close());

    /** What went wrong, for a failing run: each task, its attempts' exits and its check results. */
    const diagnose = async () => {
      const ts = await h.db.db.select().from(schema.tasks).where(eq(schema.tasks.missionId, missionId));
      const lines: string[] = [];
      for (const t of ts) {
        lines.push(`${t.key}: ${t.status} (revisions ${t.revisions}) ${t.blockedReason ?? ""}`);
        for (const a of await h.db.db.select().from(schema.attempts).where(eq(schema.attempts.taskId, t.id)))
          lines.push(`  attempt ${a.status}: ${a.exitReason ?? ""} checks=${JSON.stringify(a.checks)}`);
      }
      return lines.join("\n");
    };

    const waitMission = async (status: string, ms = 180_000) => {
      const until = Date.now() + ms;
      for (;;) {
        const [m] = await h.db.db.select().from(schema.missions).where(eq(schema.missions.id, missionId));
        if (m?.status === status) return m;
        if (m?.status === "failed" && status !== "failed")
          throw new Error(`mission failed: ${m.blockedReason ?? ""}\n${await diagnose()}`);
        if (Date.now() > until) throw new Error(`mission is ${m?.status}, wanted ${status}`);
        await new Promise((r) => setTimeout(r, 250));
      }
    };

    it("plans the goal into at least four tasks including a contract task", async () => {
      const res = await c.request("POST", "/v1/missions", {
        goal: "Add OAuth login + tests to the sample app",
        plannerAgentId: agents.planner,
      });
      expect(res.statusCode, res.body).toBe(201);
      missionId = res.json().mission.id;
      await waitMission("awaiting_approval", 60_000);
      const plans = (await c.request("GET", `/v1/missions/${missionId}/plans`)).json().plans as {
        version: number;
        graph: typeof PLAN;
        lint: { errors: unknown[]; fixes: { task: string }[] };
      }[];
      const latest = plans.at(-1)!;
      expect(latest.graph.tasks.length).toBeGreaterThanOrEqual(4);
      expect(latest.graph.tasks.some((t) => t.type.startsWith("design."))).toBe(true);
      expect(latest.lint.errors).toEqual([]);
      // Lint made both consumers wait for the contract.
      expect(latest.graph.tasks.find((t) => t.key === "api.auth")?.dependsOn).toContain("contract.auth-api");
      expect(latest.graph.tasks.find((t) => t.key === "web.signin")?.dependsOn).toContain(
        "contract.auth-api",
      );
    }, 120_000);

    it("edits the plan to put the two coding tasks on two different vendors, then approves it", async () => {
      const [plan] = (await c.request("GET", `/v1/missions/${missionId}/plans`)).json().plans.slice(-1);
      const edit = await c.request("POST", `/v1/missions/${missionId}/plans/${plan.version}/edits`, {
        edits: [
          { op: "pin", key: "api.auth", agentId: agents.coder },
          { op: "pin", key: "web.signin", agentId: agents.writer },
          { op: "pin", key: "contract.auth-api", agentId: agents.coder },
          { op: "pin", key: "docs.auth", agentId: agents.writer },
        ],
      });
      expect(edit.statusCode, edit.body).toBe(201);
      const approved = await c.request(
        "POST",
        `/v1/missions/${missionId}/plans/${edit.json().plan.version}/approve`,
      );
      expect(approved.statusCode, approved.body).toBe(200);
      await waitMission("running", 10_000);
    });

    it("keeps going when the API is killed mid-mission and restarted", async () => {
      // Wait until the contract is done and both coders were dispatched (the sign-in coder is held mid-run).
      const until = Date.now() + 120_000;
      for (;;) {
        const ts = await h.db.db.select().from(schema.tasks).where(eq(schema.tasks.missionId, missionId));
        const signin = ts.find((t) => t.key === "web.signin");
        if (signin?.status === "running") break;
        if (Date.now() > until)
          throw new Error(`sign-in task never ran: ${ts.map((t) => `${t.key}=${t.status}`).join(", ")}`);
        await new Promise((r) => setTimeout(r, 250));
      }
      await h.restartApi();
      releaseSignin();
      const m = await waitMission("done");
      expect(m.status).toBe("done");
    }, 300_000);

    it("left the evidence: tasks done, two vendors overlapping in time, leases that never overlapped, handoffs, a passing check", async () => {
      const events = await readEventsSince(h.db.db, missionId, 0, 10_000);
      const types = events.map((e) => e.type);
      for (const t of [
        "plan.proposed",
        "plan.edited",
        "plan.approved",
        "mission.started",
        "lease.granted",
        "handoff.created",
        "check.result",
        "task.done",
        "mission.done",
      ])
        expect(types, t).toContain(t);
      expect(types.filter((t) => t === "task.done")).toHaveLength(4);

      const ts = await h.db.db
        .select()
        .from(schema.tasks)
        .where(and(eq(schema.tasks.missionId, missionId)));
      const byKey = Object.fromEntries(ts.map((t) => [t.key, t]));
      const attempt = async (key: string) =>
        (await h.db.db.select().from(schema.attempts).where(eq(schema.attempts.taskId, byKey[key]!.id))).find(
          (a) => a.status === "succeeded",
        )!;
      const api = await attempt("api.auth");
      const web = await attempt("web.signin");
      expect(api.startedAt! < web.endedAt! && web.startedAt! < api.endedAt!).toBe(true);
      expect(
        (api.dispatch as { agent: { connector: { presetKey: string } } }).agent.connector.presetKey,
      ).toBe("openai");
      expect(
        (web.dispatch as { agent: { connector: { presetKey: string } } }).agent.connector.presetKey,
      ).toBe("anthropic");

      const leases = await h.db.db.select().from(schema.leases);
      for (const a of leases)
        for (const b of leases) {
          if (a.id >= b.id || a.taskId === b.taskId) continue;
          const aEnd = a.releasedAt ?? new Date();
          const bEnd = b.releasedAt ?? new Date();
          const overlapInTime = a.createdAt < bEnd && b.createdAt < aEnd;
          if (overlapInTime)
            expect(a.resource.split("/")[0], `${a.resource} vs ${b.resource}`).not.toBe(
              b.resource.split("/")[0],
            );
        }
      expect(leases.every((l) => l.releasedAt)).toBe(true);

      const handoffs = await h.db.db
        .select()
        .from(schema.handoffs)
        .where(eq(schema.handoffs.toTaskId, byKey["docs.auth"]!.id));
      expect(handoffs.map((x) => x.packet.from.taskKey).sort()).toEqual(["api.auth", "web.signin"]);
      const docs = await attempt("docs.auth");
      const answer = events.find((e) => e.type === "attempt.message" && e.attemptId === docs.id);
      expect((answer?.payload as { text?: string } | undefined)?.text).toContain("session cookie");

      const checks = events
        .filter((e) => e.type === "check.result")
        .map((e) => e.payload as { kind: string; passed: boolean });
      expect(checks.find((x) => x.kind === "tests")?.passed).toBe(true);
      expect(checks.every((x) => x.passed)).toBe(true);
    });
  },
);
