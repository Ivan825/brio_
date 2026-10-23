// M9 acceptance (policies): a confidential task can never be routed to a connector its data may not reach. Without a
// policy it stays on local models; a data-routing policy can allow more; the connector allow-list (deny wins) applies to
// all work; a dispatch is checked again whatever chose the agent; network policies shape every sandbox. Needs Postgres.
import { schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { and, eq, gt } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";
import { ScriptedVendors } from "./vendors";

const OPENAI_KEY = ["sk", "proj", "policy0123456789abcdefghi"].join("-");
const price = { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null };

const task = (key: string, sensitivity: string, extra: Record<string, unknown> = {}) => ({
  key,
  type: "write.summary",
  title: `Task ${key}`,
  contract: {
    objective: `Do ${key}`,
    inputs: [],
    outputs: [{ kind: "report", description: key }],
    acceptance: [{ kind: "diff_scope", hard: true }],
    constraints: [],
    sensitivity,
  },
  dependsOn: [],
  suggestedMode: "single",
  ...extra,
});

describe.skipIf(!hasTestDatabase)("M9 acceptance: policies", () => {
  const vendors = new ScriptedVendors(() => ({ text: "ok" }), {
    "http://localhost:11434/v1/models": {
      body: JSON.stringify({ data: [{ id: "llama-local" }] }),
      type: "application/json",
    },
  });
  let h: Harness;
  let c: Client;
  const agent: Record<string, string> = {};

  beforeAll(async () => {
    // No runner: routing decisions are what is tested; attempts stay queued with their dispatch.
    h = await startHarness({ runner: false, fetch: vendors.fetch });
    c = new Client(h);
    await c.signIn("policies@example.com");
    await c.request("POST", "/v1/workspaces", { name: "Policies" });
    const openai = (
      await c.request("POST", "/v1/connectors", { registryKey: "openai-api", apiKey: OPENAI_KEY })
    ).json().connector;
    const ollama = await c.request("POST", "/v1/connectors", {
      registryKey: "local-models",
      preset: "ollama",
    });
    expect(ollama.statusCode, ollama.body).toBe(201);
    for (const [name, connectorId, model] of [
      ["cloud", openai.id, "gpt-coder"],
      ["local", ollama.json().connector.id, "llama-local"],
    ] as const)
      agent[name] = (
        await c.request("POST", "/v1/agents", { connectorId, name, model, priceOverride: price })
      ).json().agent.id;
  });
  afterAll(async () => {
    await h?.close();
  });

  /** Starts a mission on the plan and returns its tasks once the scheduler has routed or blocked them. */
  async function run(tasks: unknown[], routing?: unknown) {
    const m = await c.request("POST", "/v1/missions", {
      goal: "Policy",
      plan: { tasks, assumptions: [], questions: [] },
      ...(routing ? { routing } : {}),
    });
    const id = m.json().mission.id;
    expect((await c.request("POST", `/v1/missions/${id}/plans/1/approve`)).statusCode).toBe(200);
    for (let i = 0; i < 100; i++) {
      const rows = await h.db.db
        .select()
        .from(schema.tasks)
        .where(and(eq(schema.tasks.missionId, id), gt(schema.tasks.planVersion, 0)));
      if (rows.every((t) => t.status === "running" || t.status === "blocked")) {
        const attempts = await h.db.db
          .select({ a: schema.attempts, key: schema.tasks.key })
          .from(schema.attempts)
          .innerJoin(schema.tasks, eq(schema.tasks.id, schema.attempts.taskId))
          .where(eq(schema.tasks.missionId, id));
        return { id, tasks: rows, attempts };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("the tasks were neither routed nor blocked");
  }

  it("keeps confidential work on local models; internal work may go anywhere", async () => {
    const { attempts, tasks } = await run([task("secret", "confidential"), task("open", "internal")]);
    const by = Object.fromEntries(attempts.map((x) => [x.key, x.a.agentId]));
    const why = tasks.map((t) => `${t.key}: ${t.status} ${t.blockedReason ?? ""}`).join("; ");
    expect(by.secret, why).toBe(agent.local);
    expect([agent.local, agent.cloud], why).toContain(by.open);
  });

  it("blocks confidential work when only a cloud agent could take it, and refuses a direct run", async () => {
    const { tasks } = await run([task("secret", "confidential")], {
      strategy: "single",
      agentId: agent.cloud,
    });
    expect(tasks[0]?.status).toBe("blocked");
    expect(tasks[0]?.blockedReason).toMatch(
      /^policy: cloud may not take this task \(confidential work goes only to local models/,
    );
    const direct = await c.request("POST", `/v1/tasks/${tasks[0]?.id}/attempts`, { agentId: agent.cloud });
    expect(direct.statusCode).toBe(422);
    expect(direct.json().error).toBe("policy_denied");
  });

  it("lets a data-routing policy allow a connector for confidential work, and the allow-list deny it again", async () => {
    const allow = await c.request("POST", "/v1/policies", {
      kind: "data_routing",
      name: "Our OpenAI tenant may see confidential work",
      rule: { sensitivity: "confidential", allow: { connectors: ["openai-api"] } },
    });
    expect(allow.statusCode, allow.body).toBe(201);
    const first = await run([task("secret", "confidential")]);
    expect(first.attempts[0]?.a.agentId, first.tasks[0]?.blockedReason ?? "").toBe(agent.cloud);

    const deny = await c.request("POST", "/v1/policies", {
      kind: "connector_allow",
      name: "No OpenAI",
      rule: { deny: ["openai-api"] },
    });
    expect(deny.statusCode, deny.body).toBe(201);
    const second = await run([task("open", "internal")], { strategy: "single", agentId: agent.cloud });
    expect(second.tasks[0]?.blockedReason).toContain('policy "No OpenAI" denies openai-api');
    await c.request("DELETE", `/v1/policies/${deny.json().policy.id}`);
    await c.request("PATCH", `/v1/policies/${allow.json().policy.id}`, { enabled: false });
  });

  it("shapes every sandbox's network: denied hosts out, allowed ones in for code", async () => {
    const net = await c.request("POST", "/v1/policies", {
      kind: "network",
      name: "Internal registry only",
      rule: { denyHosts: ["registry.npmjs.org"], allowHosts: ["npm.acme.internal"] },
    });
    expect(net.statusCode, net.body).toBe(201);
    const code = task("build", "internal", {
      type: "code.feature",
      contract: {
        objective: "Build it",
        inputs: [],
        outputs: [{ kind: "diff", description: "code" }],
        acceptance: [{ kind: "tests", command: "true", hard: true }],
        constraints: [],
        expectedFootprint: { paths: ["src/**"] },
        sensitivity: "internal",
      },
    });
    // A coding CLI's sandbox has an egress allowlist (a model-API agent's tools run with no network at all).
    const cli = (
      await c.request("POST", "/v1/connectors", {
        registryKey: "claude-code",
        apiKey: ["sk", "ant", "api03", "policy0123456789abcdefgh"].join("-"),
      })
    ).json().connector;
    const coder = (
      await c.request("POST", "/v1/agents", { connectorId: cli.id, name: "coder", model: "claude-writer" })
    ).json().agent.id;
    const { attempts } = await run([code], { strategy: "single", agentId: coder });
    const dispatch = attempts[0]?.a.dispatch as { sandbox?: { network?: { hosts?: string[] } } } | undefined;
    const hosts = dispatch?.sandbox?.network?.hosts ?? [];
    expect(hosts).toContain("npm.acme.internal");
    expect(hosts).not.toContain("registry.npmjs.org");
    expect(hosts).toContain("github.com");

    const listed = (await c.request("GET", "/v1/policies")).json().policies;
    expect(listed.map((p: { kind: string }) => p.kind).sort()).toEqual(["data_routing", "network"]);
    const ledger = await h.db.db.select().from(schema.ledger).where(eq(schema.ledger.kind, "policy.change"));
    expect(ledger.length).toBeGreaterThanOrEqual(5);
  });

  it("refuses malformed rules", async () => {
    const bad = await c.request("POST", "/v1/policies", {
      kind: "data_routing",
      name: "Nothing",
      rule: { sensitivity: "confidential", allow: {} },
    });
    expect(bad.statusCode).toBe(400);
  });
});
