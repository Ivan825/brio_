// M10 (D-105): usage analytics, the billing hook and the public status page. Usage adds up a workspace's attempts by
// day, agent, vendor and task type; the billing hook sends each finished day once, signed, and tries again after a
// failure; the status page says whether each part of Brio works, to anyone, with nothing about any workspace.
// Needs Postgres.
import { createHmac } from "node:crypto";
import { schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";

const SECRET = ["whsec", "billingtest0123456789abcdefghijk"].join("_");
const HOOK = "https://billing.example.com/brio";
const OPENAI_KEY = ["sk", "proj", "usage0123456789abcdefghijk"].join("-");

describe.skipIf(!hasTestDatabase)("M10: usage, the billing hook, status", () => {
  const posts: Array<{ headers: Record<string, string>; body: string }> = [];
  let hookStatus = 200;
  let h: Harness;
  let c: Client;
  let workspaceId: string;
  let agentId: string;
  let taskId: string;
  const yesterday = new Date(Date.now() - 86_400_000);
  const day = yesterday.toISOString().slice(0, 10);

  beforeAll(async () => {
    h = await startHarness({
      runner: false,
      env: { BRIO_BILLING_WEBHOOK_URL: HOOK, BRIO_BILLING_WEBHOOK_SECRET: SECRET },
      fetch: async (input, init) => {
        if (String(input) === HOOK) {
          posts.push({
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
            body: String(init?.body ?? ""),
          });
          return new Response("ok", { status: hookStatus });
        }
        if (String(input).startsWith("https://api.openai.com/v1/models"))
          return Response.json({ data: [{ id: "gpt-coder" }] });
        return new Response("{}", { status: 404 });
      },
    });
    c = new Client(h);
    await c.signIn("usage@example.com");
    workspaceId = (await c.request("POST", "/v1/workspaces", { name: "Usage" })).json().workspace.id;
    // Another workspace with nothing that day.
    const idle = new Client(h);
    await idle.signIn("idle@example.com");
    await idle.request("POST", "/v1/workspaces", { name: "Idle" });
    const connector = (
      await c.request("POST", "/v1/connectors", { registryKey: "openai-api", apiKey: OPENAI_KEY })
    ).json().connector;
    agentId = (
      await c.request("POST", "/v1/agents", {
        connectorId: connector.id,
        name: "coder",
        model: "gpt-coder",
        priceOverride: { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null },
      })
    ).json().agent.id;
    const [m] = await h.db.db
      .insert(schema.missions)
      .values({ workspaceId, title: "Usage", goal: "Usage", status: "done" })
      .returning();
    const [t] = await h.db.db
      .insert(schema.tasks)
      .values({
        workspaceId,
        missionId: m!.id,
        planVersion: 1,
        key: "t",
        type: "code.feature",
        title: "T",
        contract: {
          objective: "T",
          inputs: [],
          outputs: [{ kind: "diff", description: "t" }],
          acceptance: [{ kind: "diff_scope", hard: true }],
          constraints: [],
          sensitivity: "internal",
        },
      })
      .returning();
    taskId = t!.id;
    for (const [status, cost] of [
      ["succeeded", 0.25],
      ["succeeded", 0.5],
      ["failed", 0.125],
    ] as const)
      await h.db.db.insert(schema.attempts).values({
        workspaceId,
        taskId,
        agentId,
        role: "maker",
        status,
        costUsd: cost,
        tokensIn: 1000,
        tokensOut: 100,
        createdAt: yesterday,
      });
  });
  afterAll(async () => {
    await h?.close();
  });

  it("adds up a workspace's usage by day, agent, vendor and task type", async () => {
    const res = await c.request("GET", "/v1/usage?days=7");
    expect(res.statusCode, res.body).toBe(200);
    const { usage } = res.json();
    expect(usage.totals).toMatchObject({
      costUsd: 0.875,
      attempts: 3,
      succeeded: 2,
      failed: 1,
      tokensIn: 3000,
      tokensOut: 300,
    });
    expect(usage.byDay).toEqual([{ day, costUsd: 0.875, attempts: 3 }]);
    expect(usage.byAgent).toEqual([
      expect.objectContaining({
        agentId,
        name: "coder",
        model: "gpt-coder",
        costUsd: 0.875,
        attempts: 3,
        succeeded: 2,
      }),
    ]);
    expect(usage.byVendor).toEqual([{ connector: "openai-api", costUsd: 0.875, attempts: 3 }]);
    expect(usage.byTaskType).toEqual([
      expect.objectContaining({ taskType: "code.feature", costUsd: 0.875, attempts: 3, succeeded: 2 }),
    ]);
    // Nothing of it reaches another workspace.
    const outsider = new Client(h);
    await outsider.signIn("outsider-usage@example.com");
    const theirs = (await outsider.request("POST", "/v1/workspaces", { name: "Theirs" })).json().workspace.id;
    const other = await outsider.request("GET", "/v1/usage?days=7", undefined, {
      "x-brio-workspace": theirs,
    });
    expect(other.json().usage.totals.attempts).toBe(0);
  });

  it("sends each finished day's usage once, signed, and again after a failure", async () => {
    hookStatus = 503;
    expect(await h.server.ctx.billing.run()).toEqual({ sent: 0, failed: 1 });
    hookStatus = 200;
    posts.length = 0;
    expect(await h.server.ctx.billing.run()).toEqual({ sent: 1, failed: 0 });
    expect(posts).toHaveLength(1);
    const [post] = posts;
    const sig = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(post!.headers["brio-signature"] ?? "");
    expect(sig).not.toBeNull();
    expect(sig![2]).toBe(createHmac("sha256", SECRET).update(`${sig![1]}.${post!.body}`).digest("hex"));
    expect(post!.headers["idempotency-key"]).toBe(`${workspaceId}:${day}`);
    const body = JSON.parse(post!.body);
    expect(body).toMatchObject({
      type: "brio.usage.daily",
      day,
      workspace: { id: workspaceId, name: "Usage" },
    });
    expect(body.usage.totals.costUsd).toBe(0.875);
    // Sent days are not sent again; the idle workspace was never sent anything.
    posts.length = 0;
    expect(await h.server.ctx.billing.run()).toEqual({ sent: 0, failed: 0 });
    expect(posts).toEqual([]);
    const [row] = await h.db.db
      .select()
      .from(schema.usageReports)
      .where(eq(schema.usageReports.workspaceId, workspaceId));
    expect(row).toMatchObject({ day, status: "sent", tries: 2 });
  });

  it("tells anyone whether each part works, and nothing about any workspace", async () => {
    const res = await h.server.app.inject({ method: "GET", url: "/v1/status" });
    expect(res.statusCode).toBe(200);
    const status = res.json();
    expect(status.status).toBe("operational");
    expect(status.components.map((x: { name: string }) => x.name)).toEqual([
      "API",
      "Database",
      "Live events",
      "Runners",
    ]);
    expect(res.body).not.toContain(workspaceId);
    expect(res.body).not.toMatch(/usage|coder|openai/i);
  });
});
