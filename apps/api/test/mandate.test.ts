// M9 (D-07): the optional Mandate connection. A workspace connects one mandate (its URL and agent token, checked with
// Mandate, kept in the vault). Every paid attempt then asks that mandate first, for the attempt's cap, from the
// vendor that bills it; the attempt may spend no more than was held, and what it really cost is captured when it ends.
// A request a person must approve keeps its task blocked until they say yes in Mandate; a decline or an unreachable
// Mandate blocks it too (fail closed). Needs Postgres.
import { readEventsSince, schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";
import { ScriptedVendors } from "./vendors";

const OPENAI_KEY = ["sk", "proj", "mandate0123456789abcdefgh"].join("-");
const TOKEN = ["mnd", "brioTestToken0123456789abcdef"].join("_");
const MANDATE = "https://mandate.example.com";

interface Request {
  key: string;
  body: { amount: number; merchant: string; purpose: string; category: string; currency: string };
}

/** Mandate's agent API, as far as Brio uses it. */
class FakeMandate {
  currency = "USD";
  /** What a new request gets: approved, a person's decision, declined, or Mandate down. */
  mode: "approve" | "ask" | "decline" | "down" = "approve";
  readonly requests: Request[] = [];
  readonly decided = new Map<string, "approved" | "denied">();
  readonly firstBody = new Map<string, string>();
  readonly captures: Array<{ transactionId: string; amount: number }> = [];
  readonly voids: string[] = [];
  readonly asked = new Map<string, "ask">();

  constructor(private readonly vendors: ScriptedVendors) {}

  readonly fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    if (!url.startsWith(MANDATE)) return this.vendors.fetch(input, init);
    const headers = new Headers(init.headers);
    const json = (v: unknown, status = 200) =>
      new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (headers.get("authorization") !== `Bearer ${TOKEN}`) return json({ error: "unauthorized" }, 401);
    if (this.mode === "down") return json({ error: "unavailable" }, 503);
    const path = new URL(url).pathname;
    if (path === "/api/agent/mandate")
      return json({
        mandateId: "mnd-1",
        mandate: { name: "Brio agents" },
        status: "active",
        currency: this.currency,
        remaining: { today: 5000, total: 20000 },
        pendingApprovals: 0,
      });
    const body = JSON.parse(String(init.body ?? "{}"));
    if (path === "/api/agent/authorize") {
      const key = headers.get("idempotency-key") ?? "";
      this.requests.push({ key, body });
      // Same key, different body: Mandate refuses it (422).
      const raw = JSON.stringify(body);
      if (this.firstBody.has(key) && this.firstBody.get(key) !== raw)
        return json({ error: "idempotency_key_reused" }, 422);
      this.firstBody.set(key, raw);
      const tx = `txn_${key.slice(-8)}`;
      const decided = this.decided.get(key);
      if (decided === "approved" || (!decided && !this.asked.has(key) && this.mode === "approve"))
        return json({
          decision: "approved",
          rule: decided ? "allowance" : "limits",
          transactionId: tx,
          settlement: "held",
        });
      if (decided === "denied")
        return json({ decision: "declined", rule: "denied_recently", reason: "a person said no" }, 403);
      if (this.mode === "decline" && !this.asked.has(key))
        return json(
          {
            decision: "declined",
            rule: "daily",
            reason: "over the daily limit",
            remedy: { message: "over the daily limit of $50.00" },
          },
          403,
        );
      this.asked.set(key, "ask");
      return json(
        {
          decision: "pending",
          rule: "approval",
          approvalId: `apr_${key.slice(-6)}`,
          remedy: { message: "above $0.50 needs a yes", approvalRequired: true },
        },
        202,
      );
    }
    if (path === "/api/agent/capture") {
      this.captures.push({ transactionId: body.transactionId, amount: body.amount });
      return json({ transactionId: body.transactionId, settlement: "captured" });
    }
    if (path === "/api/agent/void") {
      this.voids.push(body.transactionId);
      return json({ transactionId: body.transactionId, settlement: "voided" });
    }
    return json({ error: "not_found" }, 404);
  };
}

const PLAN = (title: string) => ({
  tasks: [
    {
      key: "t",
      type: "write.summary",
      title,
      contract: {
        objective: title,
        inputs: [],
        outputs: [{ kind: "report", description: title }],
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
});

describe.skipIf(!hasTestDatabase)("M9: the optional Mandate connection (D-07)", () => {
  const mandate = new FakeMandate(new ScriptedVendors(() => ({ text: "done" })));
  let h: Harness;
  let c: Client;
  let workspaceId: string;
  let agentId: string;

  beforeAll(async () => {
    h = await startHarness({ fetch: mandate.fetch });
    c = new Client(h);
    await c.signIn("mandate@example.com");
    workspaceId = (await c.request("POST", "/v1/workspaces", { name: "Mandated" })).json().workspace.id;
    const openai = (
      await c.request("POST", "/v1/connectors", { registryKey: "openai-api", apiKey: OPENAI_KEY })
    ).json().connector;
    agentId = (
      await c.request("POST", "/v1/agents", {
        connectorId: openai.id,
        name: "writer",
        model: "gpt-coder",
        priceOverride: { inputPerM: 10, outputPerM: 0, cachedInputPerM: null, cacheWritePerM: null },
        limits: { maxCostUsd: 0.75 },
      })
    ).json().agent.id;
  });
  afterAll(async () => {
    await h?.close();
  });

  async function start(title: string) {
    const m = await c.request("POST", "/v1/missions", {
      goal: title,
      plan: PLAN(title),
      routing: { strategy: "single", agentId },
    });
    const id = m.json().mission.id as string;
    expect((await c.request("POST", `/v1/missions/${id}/plans/1/approve`)).statusCode).toBe(200);
    return id;
  }

  async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
    for (let i = 0; i < 300; i++) {
      const v = await read();
      if (ok(v)) return v;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  const taskOf = async (missionId: string) =>
    (await h.db.db.select().from(schema.tasks).where(eq(schema.tasks.missionId, missionId)))[0]!;
  const missionOf = async (id: string) =>
    (await h.db.db.select().from(schema.missions).where(eq(schema.missions.id, id)))[0]!;

  it("connects a mandate after checking it with Mandate, keeping the token in the vault", async () => {
    expect(
      (await c.request("PUT", "/v1/integrations/mandate", { baseUrl: MANDATE, token: "sk-nope" })).statusCode,
    ).toBe(400);
    mandate.currency = "EUR";
    const eur = await c.request("PUT", "/v1/integrations/mandate", { baseUrl: MANDATE, token: TOKEN });
    expect(eur.json().error).toBe("mandate_currency");
    mandate.currency = "USD";
    const ok = await c.request("PUT", "/v1/integrations/mandate", { baseUrl: MANDATE, token: TOKEN });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().mandate).toMatchObject({ connected: true, mandateId: "mnd-1", name: "Brio agents" });
    const view = (await c.request("GET", "/v1/integrations/mandate")).json().mandate;
    expect(view).toMatchObject({ connected: true, live: { reachable: true, status: "active" } });
    expect(JSON.stringify(await h.db.db.select().from(schema.mandateConnections))).not.toContain(TOKEN);
  });

  it("asks for the attempt's cap before it runs, and captures what it really cost", async () => {
    const id = await start("Summarise the notes");
    await until(
      () => missionOf(id),
      (m) => m.status === "done",
      "the mission",
    );
    const [req] = mandate.requests;
    expect(req?.body).toEqual({
      amount: 75,
      merchant: "OpenAI",
      purpose: "Brio: Summarise the notes",
      category: "ai.compute",
      currency: "USD",
    });
    expect(req?.key).toMatch(/^brio:/);
    // The attempt could spend no more than was held; one call at $10/M for 1,000 tokens cost one cent.
    await h.server.ctx.mandate.idle();
    const [hold] = await until(
      () => h.db.db.select().from(schema.mandateHolds),
      (r) => r[0]?.status === "captured",
      "the capture",
    );
    expect(hold).toMatchObject({ amountCents: 75, capturedCents: 1, merchant: "OpenAI" });
    expect(mandate.captures).toEqual([{ transactionId: hold!.transactionId, amount: 1 }]);
    expect(hold?.attemptId).toBeTruthy();
    const queued = (await readEventsSince(h.db.db, id, 0)).find((e) => e.type === "attempt.queued");
    expect(
      (queued?.payload as { limits?: { maxCostUsd: number } } | undefined)?.limits?.maxCostUsd,
    ).toBeLessThanOrEqual(0.75);
    const spend = (
      await h.db.db
        .select()
        .from(schema.ledger)
        .where(eq(schema.ledger.workspaceId, workspaceId))
        .orderBy(asc(schema.ledger.id))
    ).filter((l) => l.kind === "spend" && (l.payload as { mandate?: unknown }).mandate);
    expect(spend.map((l) => (l.payload as { mandate: Record<string, unknown> }).mandate)).toEqual([
      expect.objectContaining({ decision: "approved", amountCents: 75 }),
      expect.objectContaining({ settled: "captured", capturedCents: 1 }),
    ]);
  });

  it("keeps a task waiting while a person decides in Mandate, then runs it once they say yes", async () => {
    mandate.mode = "ask";
    mandate.requests.length = 0;
    const id = await start("Draft the release notes");
    const t = await until(
      () => taskOf(id),
      (x) => x.status === "blocked",
      "the task to wait for Mandate",
    );
    expect(t.blockedReason).toContain("mandate: waiting for a yes in Mandate (above $0.50 needs a yes)");
    expect(await h.db.db.select().from(schema.attempts).where(eq(schema.attempts.taskId, t.id))).toEqual([]);
    // Still undecided: the sweep asks again, the task keeps waiting.
    await h.server.ctx.mandate.sweep();
    expect((await taskOf(id)).status).toBe("blocked");
    // A person says yes in Mandate; the next sweep frees the task, which runs on what was approved.
    const key = mandate.requests[0]!.key;
    mandate.decided.set(key, "approved");
    await h.server.ctx.mandate.sweep();
    await until(
      () => missionOf(id),
      (m) => m.status === "done",
      "the mission after approval",
    );
    // Every ask for that request was exactly the same request.
    const same = mandate.requests.filter((r) => r.key === key);
    expect(same.length).toBeGreaterThanOrEqual(2);
    expect(new Set(same.map((r) => JSON.stringify(r.body))).size).toBe(1);
    await until(
      () => h.db.db.select().from(schema.mandateHolds).where(eq(schema.mandateHolds.requestKey, key)),
      (r) => r[0]?.status === "captured",
      "the capture after approval",
    );
  });

  it("blocks the task with Mandate's reason when it declines, and when Mandate cannot be reached", async () => {
    mandate.mode = "decline";
    const declined = await start("Write a long report");
    const t = await until(
      () => taskOf(declined),
      (x) => x.status === "blocked",
      "the declined task",
    );
    expect(t.blockedReason).toContain("mandate: declined — over the daily limit of $50.00");

    mandate.mode = "down";
    const down = await start("Write a short report");
    const u = await until(
      () => taskOf(down),
      (x) => x.status === "blocked",
      "the unreachable task",
    );
    expect(u.blockedReason).toMatch(/mandate: unreachable/);
    expect(await h.db.db.select().from(schema.attempts).where(eq(schema.attempts.taskId, u.id))).toEqual([]);
  });

  it("disconnects: work stops asking Mandate and the tasks it held back run", async () => {
    mandate.mode = "approve";
    const before = mandate.requests.length;
    expect((await c.request("DELETE", "/v1/integrations/mandate")).statusCode).toBe(204);
    expect((await c.request("GET", "/v1/integrations/mandate")).json().mandate).toEqual({ connected: false });
    const missions = await h.db.db
      .select()
      .from(schema.missions)
      .where(eq(schema.missions.workspaceId, workspaceId));
    for (const m of missions)
      await until(
        () => missionOf(m.id),
        (x) => x.status === "done",
        `mission ${m.title}`,
      );
    expect(mandate.requests.length).toBe(before);
  });
});
