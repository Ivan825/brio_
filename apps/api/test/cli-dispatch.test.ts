// Coding-CLI connectors through the API: installed with the vendor's key, checked through the vendor's API, and a code
// task dispatched to the sandbox profile with the CLI's vendor host as the only egress beside registries and git.
import { schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";

const KEY = ["sk", "ant", "api03", "clidispatch0123456789abcd"].join("-");

describe.skipIf(!hasTestDatabase)("coding-CLI dispatch", () => {
  let h: Harness;
  let c: Client;
  let workspaceId: string;
  const vendor = async (url: string | URL) => {
    if (String(url).startsWith("https://api.anthropic.com/v1/models"))
      return new Response(JSON.stringify({ data: [{ id: "claude-sonnet-5-5" }], has_more: false }), {
        headers: { "content-type": "application/json" },
      });
    return new Response("{}", { status: 404 });
  };

  beforeAll(async () => {
    h = await startHarness({ fetch: vendor, runner: false });
    c = new Client(h);
    await c.signIn("cli@example.com");
    workspaceId = (await c.request("POST", "/v1/workspaces", { name: "CLI" })).json().workspace.id;
  });
  afterAll(async () => h?.close());

  it("lists Claude Code as available, keyed by Anthropic", async () => {
    const cats = (await c.request("GET", "/v1/registry")).json().categories as {
      connectors: { id: string; implemented: boolean; cli: string | null; presets: { key: string }[] }[];
    }[];
    const cc = cats.flatMap((x) => x.connectors).find((x) => x.id === "claude-code")!;
    expect(cc).toMatchObject({ implemented: true, cli: "claude-code", presets: [{ key: "anthropic" }] });
  });

  it("installs the CLI with the vendor key, checked against the vendor API, and queues a sandboxed code task", async () => {
    const res = await c.request("POST", "/v1/connectors", { registryKey: "claude-code", apiKey: KEY });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().connector).toMatchObject({
      route: "cli",
      adapter: "claude-code",
      preset: "anthropic",
      health: { ok: true },
    });

    const agent = await c.request("POST", "/v1/agents", {
      connectorId: res.json().connector.id,
      name: "claude",
      model: "claude-sonnet-5-5",
    });
    expect(agent.json().agent.runnable, agent.body).toBe(true);

    const mission = (await c.request("POST", "/v1/missions", { goal: "add sub()" })).json().mission;
    const [task] = await h.db.db.select().from(schema.tasks).where(eq(schema.tasks.missionId, mission.id));
    // The stub planner's task is a plan; make it a code task as M3's planner would.
    await h.db.db.update(schema.tasks).set({ type: "code.feature" }).where(eq(schema.tasks.id, task!.id));

    const run = await c.request("POST", `/v1/tasks/${task!.id}/attempts`, { agentId: agent.json().agent.id });
    expect(run.statusCode, run.body).toBe(202);
    const [a] = await h.db.db
      .select()
      .from(schema.attempts)
      .where(eq(schema.attempts.id, run.json().attempt.id));
    expect(a?.status).toBe("queued");
    const dispatch = a?.dispatch as Record<string, unknown> & {
      sandbox: { profile: string; network: { mode: string; hosts: string[] } };
    };
    expect(dispatch).toMatchObject({ adapterKey: "claude-code", route: "cli", image: "cli", repo: null });
    expect(dispatch.sandbox.profile).toBe("code-standard");
    expect(dispatch.sandbox.network.hosts).toContain("api.anthropic.com");
    expect(dispatch.sandbox.network.hosts).not.toContain("api.openai.com");
    expect(JSON.stringify(dispatch)).not.toContain(KEY);

    const cancel = await c.request("POST", `/v1/attempts/${run.json().attempt.id}/cancel`);
    expect(cancel.statusCode, cancel.body).toBe(200);
    const [after] = await h.db.db
      .select()
      .from(schema.attempts)
      .where(eq(schema.attempts.id, run.json().attempt.id));
    expect(after?.status).toBe("cancelled");
    void workspaceId;
  });
});
