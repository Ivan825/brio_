// M1 acceptance through the API, against a scripted vendor: add keys, health checks, live model lists, agents, and a
// one-task mission run whose cost matches the vendor's usage. The key never leaves the vault in plaintext.
import { readEventsSince, schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";

const { attempts, connectors, vaultSecrets } = schema;

// Built at runtime: no key-shaped literal in the repository.
const OPENAI_KEY = ["sk", "proj", "acceptance0123456789abcdef"].join("-");
const ANTHROPIC_KEY = ["sk", "ant", "api03", "acceptance0123456789abcdef"].join("-");

type Reply = { status?: number; body: unknown; headers?: Record<string, string> } | "hang";

/** One fake internet: model lists by host, generations from a queue, every request recorded. */
class Vendors {
  requests: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  queue: Reply[] = [];
  readonly fetch = async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    this.requests.push({
      url,
      method,
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...extra },
      });
    if (method === "GET") {
      if (url.startsWith("https://api.openai.com/v1/models")) {
        if (headers.authorization !== `Bearer ${OPENAI_KEY}`)
          return json({ error: { message: "bad key" } }, 401);
        return json({
          object: "list",
          data: [
            { id: "gpt-6.1-sol", created: 1760000000 },
            { id: "brand-new-model", created: 1760000001 },
          ],
        });
      }
      if (url.startsWith("https://api.anthropic.com/v1/models"))
        return json({
          data: [{ id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", max_input_tokens: 1000000 }],
          has_more: false,
        });
      if (url.startsWith("http://localhost:11434/v1/models"))
        return json({ object: "list", data: [{ id: "qwen3:8b" }] });
      return json({ error: { message: "not found" } }, 404);
    }
    const next = this.queue.shift();
    if (!next) return json({ error: { message: "no scripted reply" } }, 500);
    if (next === "hang")
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    return json(next.body, next.status ?? 200, next.headers);
  };
}

/** OpenAI's default API style is Responses. */
const answer = (text: string, input: number, output: number, cached = 0) => ({
  body: {
    id: "resp_1",
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: input, input_tokens_details: { cached_tokens: cached }, output_tokens: output },
  },
});

describe.skipIf(!hasTestDatabase)("M1 acceptance: connectors, agents, metered runs", () => {
  const vendors = new Vendors();
  let h: Harness;
  let owner: Client;
  let member: Client;
  let workspaceId: string;
  let openaiId: string;
  let missionTaskId: string;
  let missionId: string;

  beforeAll(async () => {
    h = await startHarness({ fetch: vendors.fetch });
    owner = new Client(h);
    member = new Client(h);
    await owner.signIn("owner@example.com");
    workspaceId = (await owner.request("POST", "/v1/workspaces", { name: "Metered" })).json().workspace.id;
    await member.signIn("member@example.com");
    const inv = await owner.request("POST", `/v1/workspaces/${workspaceId}/invitations`, {
      email: "member@example.com",
    });
    await member.request("POST", "/api/auth/organization/accept-invitation", {
      invitationId: inv.json().invitation.id,
    });
    await member.request("POST", `/v1/workspaces/${workspaceId}/activate`);
  });
  afterAll(async () => h?.close());

  it("serves the catalogue: 13 categories, what is available now, Meta marked region-limited", async () => {
    const res = await owner.request("GET", "/v1/registry");
    expect(res.statusCode).toBe(200);
    const cats = res.json().categories as {
      connectors: { id: string; implemented: boolean; regionLimited: string | null }[];
    }[];
    expect(cats).toHaveLength(13);
    const all = cats.flatMap((c) => c.connectors);
    expect(all).toHaveLength(98);
    expect(all.find((c) => c.id === "openai-api")?.implemented).toBe(true);
    expect(all.find((c) => c.id === "jules")?.implemented).toBe(false);
    expect(all.find((c) => c.id === "meta-model-api-muse-spark")?.regionLimited).toBeTruthy();
  });

  it("only owners and admins add connectors", async () => {
    const res = await member.request("POST", "/v1/connectors", {
      registryKey: "openai-api",
      apiKey: OPENAI_KEY,
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses unsafe base URLs and unsupported connectors", async () => {
    const meta = await owner.request("POST", "/v1/connectors", {
      registryKey: "local-models",
      preset: "ollama",
      baseUrl: "http://169.254.169.254/v1",
    });
    expect(meta.statusCode).toBe(422);
    expect(meta.json().error).toBe("unsafe_url");
    const midjourney = await owner.request("POST", "/v1/connectors", {
      registryKey: "midjourney",
      apiKey: "x".repeat(20),
    });
    expect([404, 422]).toContain(midjourney.statusCode);
  });

  it("adds an OpenAI key: stored encrypted, health checked live, recorded on the ledger", async () => {
    const res = await owner.request("POST", "/v1/connectors", {
      registryKey: "openai-api",
      apiKey: OPENAI_KEY,
    });
    expect(res.statusCode, res.body).toBe(201);
    const c = res.json().connector;
    openaiId = c.id;
    expect(c).toMatchObject({
      preset: "openai",
      baseUrl: "https://api.openai.com/v1",
      hasKey: true,
      status: "active",
    });
    expect(c.health).toMatchObject({ ok: true, detail: "2 models available" });

    const [row] = await h.db.db.select().from(connectors).where(eq(connectors.id, openaiId));
    expect(JSON.stringify(row)).not.toContain(OPENAI_KEY);
    const [secret] = await h.db.db
      .select()
      .from(vaultSecrets)
      .where(eq(vaultSecrets.id, row!.credentialRef!));
    expect(secret!.ciphertext.toString("utf8")).not.toContain(OPENAI_KEY);
    const kinds = (await h.server.ctx.ledger.entries(h.db.db, workspaceId)).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["key.added", "connector.added"]));
  });

  it("adds Anthropic, and a local Ollama without a key (4 vendors incl. a bad key)", async () => {
    const a = await owner.request("POST", "/v1/connectors", {
      registryKey: "claude-api",
      apiKey: ANTHROPIC_KEY,
    });
    expect(a.statusCode, a.body).toBe(201);
    expect(a.json().connector.health.ok).toBe(true);
    const o = await owner.request("POST", "/v1/connectors", {
      registryKey: "local-models",
      preset: "ollama",
    });
    expect(o.statusCode, o.body).toBe(201);
    expect(o.json().connector).toMatchObject({
      local: true,
      hasKey: false,
      baseUrl: "http://localhost:11434/v1",
    });
    const bad = await owner.request("POST", "/v1/connectors", {
      registryKey: "together-fireworks-deepinfra",
      preset: "fireworks",
      apiKey: "fw-not-a-real-key-123",
    });
    expect(bad.statusCode).toBe(201);
    expect(bad.json().connector).toMatchObject({ status: "error", health: { ok: false } });
  });

  it("lists models live, then from cache, with prices where known", async () => {
    const live = await owner.request("GET", `/v1/connectors/${openaiId}/models`);
    expect(live.statusCode, live.body).toBe(200);
    expect(live.json().live).toBe(true);
    const models = live.json().models as { id: string; price: { inputPerM: number } | null }[];
    expect(models.map((m) => m.id)).toEqual(["brand-new-model", "gpt-6.1-sol"]);
    expect(models.find((m) => m.id === "gpt-6.1-sol")?.price?.inputPerM).toBe(2);
    expect(models.find((m) => m.id === "brand-new-model")?.price).toBeNull();
    const cached = await owner.request("GET", `/v1/connectors/${openaiId}/models`);
    expect(cached.json().live).toBe(false);
  });

  it("builds agents and says which can run", async () => {
    const known = await member.request("POST", "/v1/agents", {
      connectorId: openaiId,
      name: "writer",
      model: "gpt-6.1-sol",
      rolePrompt: "You write crisp plans.",
      limits: { maxCostUsd: 0.5 },
    });
    expect(known.statusCode, known.body).toBe(201);
    expect(known.json().agent).toMatchObject({
      runnable: true,
      modelListed: true,
      price: { kind: "table", inputPerM: 2 },
    });
    const unknown = await member.request("POST", "/v1/agents", {
      connectorId: openaiId,
      name: "new",
      model: "brand-new-model",
    });
    expect(unknown.json().agent).toMatchObject({ runnable: false, price: null });
  });

  it("runs a task with a chosen agent: events stream, cost matches the vendor's usage, answer stored", async () => {
    // A mission whose plan waits for approval, with one task: the orchestrator leaves it alone, so this exercises the
    // direct run (a person picks the agent) on its own.
    const [m] = await h.db.db
      .insert(schema.missions)
      .values({
        workspaceId,
        title: "Health endpoint",
        goal: "Plan a health endpoint for the API",
        status: "awaiting_approval",
      })
      .returning();
    missionId = m!.id;
    const [t] = await h.db.db
      .insert(schema.tasks)
      .values({
        workspaceId,
        missionId,
        planVersion: 1,
        key: "plan.health",
        type: "write.summary",
        title: "Plan a health endpoint",
        contract: {
          objective: "Plan a health endpoint for the API",
          inputs: [],
          outputs: [{ kind: "report", description: "a plan" }],
          acceptance: [{ kind: "human", hard: true }],
          constraints: [],
          sensitivity: "internal",
        },
      })
      .returning();
    missionTaskId = t!.id;
    const agents = (await member.request("GET", "/v1/agents")).json().agents as {
      id: string;
      name: string;
    }[];
    const writer = agents.find((a) => a.name === "writer")!;

    // 12,000 prompt tokens (2,000 cached) and 800 output at $2 / $0.10 cached / $10 per M.
    vendors.queue.push(
      answer("Plan: add GET /health returning {ok:true}.\n\nDetails follow.", 12_000, 800, 2_000),
    );
    const run = await member.request("POST", `/v1/tasks/${missionTaskId}/attempts`, { agentId: writer.id });
    expect(run.statusCode, run.body).toBe(202);
    const attemptId = run.json().attempt.id;
    await h.server.ctx.attempts.settled(attemptId);

    const expected = (10_000 * 2 + 2_000 * 0.1 + 800 * 10) / 1e6;
    const [a] = await h.db.db.select().from(attempts).where(eq(attempts.id, attemptId));
    expect(a, a?.exitReason ?? "").toMatchObject({ status: "succeeded", tokensIn: 12_000, tokensOut: 800 });
    expect(Math.abs(a!.costUsd - expected) / expected).toBeLessThan(0.02);

    const types = (await readEventsSince(h.db.db, missionId, 0)).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "attempt.queued",
        "attempt.started",
        "attempt.message",
        "attempt.cost",
        "attempt.finished",
      ]),
    );
    const cost = (await readEventsSince(h.db.db, missionId, 0)).find((e) => e.type === "attempt.cost")!;
    expect(cost.payload).toMatchObject({
      usd: expected,
      priceSource: "table",
      tokensIn: 12_000,
      tokensOut: 800,
    });

    const out = await member.request("GET", `/v1/attempts/${attemptId}/output`);
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain("GET /health");
    const task = (await member.request("GET", `/v1/missions/${missionId}`)).json().tasks[0];
    expect(task.status).toBe("verifying");
    expect(task.attempts[0]).toMatchObject({ id: attemptId, status: "succeeded" });

    const kinds = (await h.server.ctx.ledger.entries(h.db.db, workspaceId)).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["dispatch", "spend"]));
    const sent = vendors.requests.filter((r) => r.method === "POST").at(-1)!;
    expect(sent.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(JSON.stringify(sent.body)).toContain("Plan a health endpoint");
  });

  it("refuses to run an agent whose model has no known price", async () => {
    const agents = (await member.request("GET", "/v1/agents")).json().agents as {
      id: string;
      name: string;
    }[];
    const res = await member.request("POST", `/v1/tasks/${missionTaskId}/attempts`, {
      agentId: agents.find((a) => a.name === "new")!.id,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("price_unknown");
  });

  it("runs on the agent's own price when the table has none", async () => {
    const agents = (await member.request("GET", "/v1/agents")).json().agents as {
      id: string;
      name: string;
    }[];
    const id = agents.find((a) => a.name === "new")!.id;
    const patched = await member.request("PATCH", `/v1/agents/${id}`, {
      priceOverride: { inputPerM: 1, outputPerM: 1, cachedInputPerM: null, cacheWritePerM: null },
    });
    expect(patched.json().agent).toMatchObject({ runnable: true, price: { kind: "override" } });
    vendors.queue.push(answer("ok", 1_000_000, 1_000_000));
    const run = await member.request("POST", `/v1/tasks/${missionTaskId}/attempts`, { agentId: id });
    expect(run.statusCode, run.body).toBe(202);
    await h.server.ctx.attempts.settled(run.json().attempt.id);
    const [a] = await h.db.db.select().from(attempts).where(eq(attempts.id, run.json().attempt.id));
    // The default per-attempt limit is $1, and this call cost $2: the run is stopped as over the limit.
    expect(a).toMatchObject({ status: "failed", costUsd: 2 });
    expect(a!.exitReason).toMatch(/^limit_exceeded/);
  });

  it("cancels a running attempt within seconds", async () => {
    const agents = (await member.request("GET", "/v1/agents")).json().agents as {
      id: string;
      name: string;
    }[];
    vendors.queue.push("hang");
    const run = await member.request("POST", `/v1/tasks/${missionTaskId}/attempts`, {
      agentId: agents.find((a) => a.name === "writer")!.id,
    });
    expect(run.statusCode, run.body).toBe(202);
    const busy = await member.request("POST", `/v1/tasks/${missionTaskId}/attempts`, {
      agentId: agents.find((a) => a.name === "writer")!.id,
    });
    expect(busy.statusCode).toBe(409);
    const started = Date.now();
    const cancel = await member.request("POST", `/v1/attempts/${run.json().attempt.id}/cancel`);
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(Date.now() - started).toBeLessThan(5000);
    const [a] = await h.db.db.select().from(attempts).where(eq(attempts.id, run.json().attempt.id));
    expect(a?.status).toBe("cancelled");
    const task = (await member.request("GET", `/v1/missions/${missionId}`)).json().tasks[0];
    expect(task.status).toBe("ready");
  });

  it("never lets a key reach logs, events or the ledger", async () => {
    const events = await readEventsSince(h.db.db, missionId, 0);
    const ledger = await h.server.ctx.ledger.entries(h.db.db, workspaceId);
    const everything = JSON.stringify({ logs: h.logs, events, ledger });
    expect(everything).not.toContain(OPENAI_KEY);
    expect(everything).not.toContain(ANTHROPIC_KEY);
  });

  it("removes a connector: key destroyed, agents gone, ledger updated", async () => {
    const res = await owner.request("DELETE", `/v1/connectors/${openaiId}`);
    expect(res.statusCode).toBe(204);
    const [row] = await h.db.db.select().from(connectors).where(eq(connectors.id, openaiId));
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.credentialRef).toBeNull();
    const agents = (await owner.request("GET", "/v1/agents")).json().agents as {
      connector: { id: string } | null;
    }[];
    expect(agents.some((a) => a.connector?.id === openaiId)).toBe(false);
    const kinds = (await h.server.ctx.ledger.entries(h.db.db, workspaceId)).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["key.removed", "connector.removed"]));
  });
});
