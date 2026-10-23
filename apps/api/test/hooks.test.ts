// Manus webhooks (docs/vendors/hosted-agents.md §6): installing a Manus connector on a public Brio registers Brio's
// receiver; a signed "task stopped" event lands on the running attempt's board at once; bad signatures, stale
// timestamps and unknown receivers are refused. The run itself still follows the task by polling. Needs Postgres.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readEventsSince, schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";

const KEY = ["manus", "test", "0123456789abcdefghijklmnop"].join("-");
const APP_URL = "https://brio.example";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

function manus() {
  const registered: string[] = [];
  let stopped = false;
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const fetch = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.host !== "api.manus.ai") return json({}, 404);
    if ((init.headers as Record<string, string>)["x-manus-api-key"] !== KEY)
      return json({ message: "bad key" }, 401);
    switch (url.pathname) {
      case "/v2/user.me":
        return json({ id: "u1" });
      case "/v2/webhook.create":
        registered.push((JSON.parse(String(init.body)) as { url: string }).url);
        return json({ webhook_id: "wh_1" });
      case "/v2/webhook.publicKey":
        return json({ public_key: PEM });
      case "/v2/task.create":
        return json({ task_id: "task_1" });
      case "/v2/task.detail":
        return json({ task: { status: stopped ? "stopped" : "running", credit_usage: 3 } });
      case "/v2/task.listMessages":
        return json({
          messages: stopped ? [{ id: "m1", type: "assistant_message", content: "Summary done." }] : [],
        });
      case "/v2/task.listArtifacts":
      case "/v2/task.attachments":
        return json({ artifacts: [] });
      default:
        return json({ artifacts: [] });
    }
  };
  const stop = () => {
    stopped = true;
  };
  return { fetch, registered, stop };
}

const signed = (url: string, body: string, ts = String(Math.floor(Date.now() / 1000))) => ({
  "content-type": "application/json",
  "x-webhook-timestamp": ts,
  "x-webhook-signature": sign(
    "RSA-SHA256",
    Buffer.from(`${ts}.${url}.${createHash("sha256").update(body).digest("hex")}`),
    privateKey,
  ).toString("base64"),
});

describe.skipIf(!hasTestDatabase)("vendor webhooks", () => {
  const vendor = manus();
  let h: Harness;
  let c: Client;
  let connectorId: string;

  beforeAll(async () => {
    h = await startHarness({ fetch: vendor.fetch, env: { APP_URL } });
    c = new Client(h);
    await c.signIn("hooks@example.com");
    await c.request("POST", "/v1/workspaces", { name: "Hooks" });
  });
  afterAll(async () => h?.close());

  it("registers Brio's receiver when a Manus connector is installed", async () => {
    const res = await c.request("POST", "/v1/connectors", { registryKey: "manus", apiKey: KEY });
    expect(res.statusCode, res.body).toBe(201);
    connectorId = res.json().connector.id;
    const url = `${APP_URL}/v1/hooks/manus/${connectorId}`;
    expect(vendor.registered).toEqual([url]);
    const [row] = await h.db.db.select().from(schema.connectors).where(eq(schema.connectors.id, connectorId));
    expect((row?.config as { webhook?: unknown } | undefined)?.webhook).toEqual({ url, id: "wh_1" });
  });

  it("puts a signed event on the running attempt's board, and refuses anything else", async () => {
    const a = await c.request("POST", "/v1/agents", {
      connectorId,
      name: "manus",
      model: "standard",
      options: { usdPerUnit: 0.01, pollMs: 100 },
    });
    expect(a.statusCode, a.body).toBe(201);
    const plan = {
      tasks: [
        {
          key: "sum",
          type: "write.summary",
          title: "Summarise",
          contract: {
            objective: "Summarise the launch notes",
            inputs: [],
            outputs: [{ kind: "report", description: "a summary" }],
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
      goal: "Summarise",
      plan,
      routing: { strategy: "single", agentId: a.json().agent.id },
    });
    const id = m.json().mission.id as string;
    expect((await c.request("POST", `/v1/missions/${id}/plans/1/approve`)).statusCode).toBe(200);
    // Wait until the run knows Manus's task id.
    for (let i = 0; i < 100; i++) {
      const [att] = await h.db.db
        .select()
        .from(schema.attempts)
        .where(eq(schema.attempts.transcriptRef, "task_1"));
      if (att) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const url = `${APP_URL}/v1/hooks/manus/${connectorId}`;
    const body = JSON.stringify({
      event_type: "task_stopped",
      task_detail: { task_id: "task_1", stop_reason: "finish", message: "Summary done." },
    });
    const post = (headers: Record<string, string>, payload = body, to = connectorId) =>
      h.server.app.inject({ method: "POST", url: `/v1/hooks/manus/${to}`, headers, payload });

    expect((await post(signed(url, body))).statusCode).toBe(200);
    expect((await post(signed(url, body.replace("finish", "ask")))).statusCode).toBe(401);
    expect((await post({ ...signed(url, body), "x-webhook-signature": "AAAA" })).statusCode).toBe(401);
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    expect((await post(signed(url, body, stale))).statusCode).toBe(401);
    expect((await post(signed(url, body), body, "00000000-0000-4000-8000-000000000000")).statusCode).toBe(
      404,
    );

    const events = await readEventsSince(h.db.db, id, 0, 1000);
    const notes = events
      .filter((e) => e.type === "attempt.message")
      .map((e) => (e.payload as { text: string }).text);
    expect(notes).toContain("Manus: task stopped (finish): Summary done.");

    // The run finishes by polling, as it would without the webhook.
    vendor.stop();
    for (let i = 0; i < 100; i++) {
      const [row] = await h.db.db.select().from(schema.missions).where(eq(schema.missions.id, id));
      if (row?.status === "done") return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("the mission did not finish");
  }, 60_000);
});
