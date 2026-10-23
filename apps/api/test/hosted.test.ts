// M6 (hosted agents) end to end: install a hosted connector with its settings, check the key, build an agent on it,
// and run a code task through it. The vendor's change comes back as a patch applied to the task's worktree, where the
// task's own tests run in a sandbox like any other result. Needs Postgres and Docker.
import { schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { dockerAvailable } from "@brio/runner";
import { and, eq, gt } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";

const hasDocker = await dockerAvailable();
const KEY = ["jules", "test", "0123456789abcdefghijklmnop"].join("-");

const PATCH = [
  "diff --git a/src/greet.mjs b/src/greet.mjs",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/greet.mjs",
  "@@ -0,0 +1 @@",
  "+export const greet = (name) => `hello ${name}`;",
  "diff --git a/src/greet.test.mjs b/src/greet.test.mjs",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/greet.test.mjs",
  "@@ -0,0 +4 @@",
  '+import { test } from "node:test";',
  '+import assert from "node:assert/strict";',
  '+import { greet } from "./greet.mjs";',
  '+test("greets", () => assert.equal(greet("ada"), "hello ada"));',
  "",
].join("\n");

/** Jules as documented (docs/vendors/hosted-agents.md §4): sessions, activities with a change set, polling states. */
function julesFake() {
  const seen: string[] = [];
  let polls = 0;
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const fetch = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = init.headers as Record<string, string>;
    seen.push(`${init.method ?? "GET"} ${url.pathname}`);
    if (!url.hostname.endsWith("jules.googleapis.com")) return json({}, 404);
    if (headers["x-goog-api-key"] !== KEY) return json({ error: { message: "API key not valid" } }, 401);
    if (url.pathname === "/v1alpha/sources") return json({ sources: [] });
    if (url.pathname === "/v1alpha/sessions" && init.method === "POST")
      return json({ name: "sessions/s1", id: "s1", state: "QUEUED" });
    if (url.pathname === "/v1alpha/sessions/s1")
      return json({ id: "s1", state: polls++ < 1 ? "IN_PROGRESS" : "COMPLETED" });
    if (url.pathname === "/v1alpha/sessions/s1/activities")
      return json({
        activities: [
          { id: "a1", progressUpdated: { title: "Writing greet" } },
          { id: "a2", agentMessaged: { agentMessage: "Added greet() with a test." } },
          { id: "a3", artifacts: [{ changeSet: { gitPatch: { unidiffPatch: PATCH } } }] },
        ],
      });
    return json({}, 404);
  };
  return { fetch, seen };
}

describe.skipIf(!hasTestDatabase || !hasDocker)("hosted agents through the API", () => {
  const vendor = julesFake();
  let h: Harness;
  let c: Client;
  let agentId: string;

  beforeAll(async () => {
    h = await startHarness({ fetch: vendor.fetch });
    c = new Client(h);
    await c.signIn("hosted@example.com");
    await c.request("POST", "/v1/workspaces", { name: "Hosted" });
  });
  afterAll(async () => h?.close());

  it("checks settings against the registry, then installs the connector and checks the key", async () => {
    const bad = await c.request("POST", "/v1/connectors", {
      registryKey: "jules",
      apiKey: KEY,
      settings: { source: "github/acme" },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toBe("bad_setting");
    const wrong = await c.request("POST", "/v1/connectors", {
      registryKey: "jules",
      apiKey: KEY,
      settings: { nope: "x" },
    });
    expect(wrong.json().error).toBe("unknown_setting");
    const res = await c.request("POST", "/v1/connectors", { registryKey: "jules", apiKey: KEY });
    expect(res.statusCode, res.body).toBe(201);
    const conn = res.json().connector;
    expect(conn).toMatchObject({
      service: "jules",
      serviceKind: "hosted",
      adapter: "jules",
      route: "hosted",
    });
    expect(conn.health.ok).toBe(true);
    // Jules reports no cost: an agent on it is bounded by time only, so it can run without a price.
    const a = await c.request("POST", "/v1/agents", { connectorId: conn.id, name: "jules", model: "jules" });
    expect(a.statusCode, a.body).toBe(201);
    agentId = a.json().agent.id;
    const listed = (await c.request("GET", "/v1/agents"))
      .json()
      .agents.find((x: { id: string }) => x.id === agentId);
    expect(listed).toMatchObject({ runnable: true, connector: { service: "jules" } });
  });

  it("runs a code task: the vendor's patch lands in the worktree and the task's tests pass on it", async () => {
    const plan = {
      tasks: [
        {
          key: "greet",
          type: "code.feature",
          title: "Add greet",
          contract: {
            objective: "Add greet(name) with a test",
            inputs: [],
            outputs: [{ kind: "diff", description: "greet and its test" }],
            acceptance: [
              { kind: "tests", command: "node --test 'src/*.test.mjs'", hard: true },
              { kind: "diff_scope", hard: true },
            ],
            constraints: [],
            expectedFootprint: { paths: ["src/**"] },
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
      goal: "Add greet",
      plan,
      routing: { strategy: "single", agentId },
    });
    expect(m.statusCode, m.body).toBe(201);
    const id = m.json().mission.id;
    expect((await c.request("POST", `/v1/missions/${id}/plans/1/approve`)).statusCode).toBe(200);
    const until = Date.now() + 180_000;
    for (;;) {
      const [row] = await h.db.db.select().from(schema.missions).where(eq(schema.missions.id, id));
      if (row?.status === "done") break;
      if (row?.status === "failed" || Date.now() > until) {
        const ts = await h.db.db.select().from(schema.tasks).where(eq(schema.tasks.missionId, id));
        const at = await h.db.db.select().from(schema.attempts);
        throw new Error(
          `mission ${row?.status}: ${JSON.stringify(ts.map((t) => [t.key, t.status, t.blockedReason]))} ${JSON.stringify(at.map((a) => [a.status, a.exitReason]))}`,
        );
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    const [task] = await h.db.db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.missionId, id), gt(schema.tasks.planVersion, 0)));
    const [attempt] = await h.db.db
      .select()
      .from(schema.attempts)
      .where(eq(schema.attempts.taskId, task!.id));
    expect(attempt?.transcriptRef).toBe("s1");
    const checks = attempt?.checks as { items: { kind: string; status: string }[] };
    expect(checks.items.map((i) => [i.kind, i.status])).toEqual([
      ["tests", "passed"],
      ["diff_scope", "passed"],
    ]);
    const diff = (
      await h.db.db.select().from(schema.artifacts).where(eq(schema.artifacts.attemptId, attempt!.id))
    ).find((x) => x.kind === "diff");
    const files = (diff?.meta as { files?: { path: string }[] } | undefined)?.files ?? [];
    expect(files.map((f) => f.path).sort()).toEqual(["src/greet.mjs", "src/greet.test.mjs"]);
    expect(vendor.seen).toContain("POST /v1alpha/sessions");
  }, 240_000);
});
