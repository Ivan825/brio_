// Chat (D-109): a conversation with your agents. Each message is a task routed to one agent or answered by several
// together; the next message carries the conversation; one reply at a time; a reply can be stopped; a failed reply
// leaves the chat open; chats stay out of the missions list; and a chat can be handed to a full mission. Needs Postgres
// (replies from model APIs run no sandbox).
import { readEventsSince, schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";
import { type CallInfo, type Reply, ScriptedVendors } from "./vendors";

const OPENAI_KEY = ["sk", "proj", "chat0123456789abcdefghijk"].join("-");
const ANTHROPIC_KEY = ["sk", "ant", "api03", "chat0123456789abcdefghijk"].join("-");

let releaseSlow: () => void = () => {};
let heldOnce = false;
const slow = new Promise<void>((r) => {
  releaseSlow = r;
});

async function script(call: CallInfo): Promise<Reply> {
  if (call.body.includes("# Merge:")) return { text: "MERGED: Brio conducts agents from many vendors." };
  // The first request that asks for time is held; later ones only quote it in their context.
  if (call.body.includes("take your time") && !heldOnce) {
    heldOnce = true;
    await slow;
    return { text: "late" };
  }
  return { text: call.vendor === "openai" ? "Answer A: an orchestrator." : "Answer B: a conductor." };
}

type Turn = {
  id: string;
  status: string;
  answer: string | null;
  error: string | null;
  mode: string;
  costUsd: number;
  route: { mode: string } | null;
  attempts: Array<{ role: string; agent: string; status: string }>;
};

describe.skipIf(!hasTestDatabase)("Chat (D-109)", () => {
  const vendors = new ScriptedVendors(script);
  // While `refusing`, the vendor refuses every request (not retryable): that reply fails for good.
  let refusing = false;
  const fetch = async (input: string | URL, init: RequestInit = {}) => {
    if (refusing && typeof init.body === "string" && init.body.includes('"model"'))
      return new Response(JSON.stringify({ error: { message: "bad request" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    return vendors.fetch(input, init);
  };
  let h: Harness;
  let c: Client;
  let gpt: string;
  let claude: string;
  let chatId: string;

  const view = async () => {
    const r = await c.request("GET", `/v1/chats/${chatId}`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as { chat: { title: string }; turns: Turn[] };
  };
  const settled = async (n: number) => {
    const until = Date.now() + 90_000;
    for (;;) {
      const v = await view();
      const t = v.turns[n];
      if (t && ["done", "failed", "cancelled"].includes(t.status)) return t;
      if (Date.now() > until) throw new Error(`turn ${n}: ${JSON.stringify(t)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  beforeAll(async () => {
    h = await startHarness({ fetch });
    c = new Client(h);
    await c.signIn("chatter@example.com");
    await c.request("POST", "/v1/workspaces", { name: "Chatty" });
    const price = { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null };
    const openai = (
      await c.request("POST", "/v1/connectors", { registryKey: "openai-api", apiKey: OPENAI_KEY })
    ).json().connector.id;
    const anthropic = (
      await c.request("POST", "/v1/connectors", { registryKey: "claude-api", apiKey: ANTHROPIC_KEY })
    ).json().connector.id;
    for (const [name, connectorId, model] of [
      ["gpt", openai, "gpt-coder"],
      ["claude", anthropic, "claude-writer"],
    ] as const) {
      const r = await c.request("POST", "/v1/agents", { connectorId, name, model, priceOverride: price });
      expect(r.statusCode, r.body).toBe(201);
      if (name === "gpt") gpt = r.json().agent.id;
      else claude = r.json().agent.id;
    }
  });
  afterAll(async () => {
    releaseSlow();
    await h?.close();
  });

  it("answers the first message with both vendors together, merged", { timeout: 120_000 }, async () => {
    const r = await c.request("POST", "/v1/chats", {
      message: "What is Brio?",
      mode: "together",
      agentIds: [gpt, claude],
    });
    expect(r.statusCode, r.body).toBe(201);
    chatId = r.json().chat.id;
    const t = await settled(0);
    expect(t.status, JSON.stringify(t)).toBe("done");
    expect(t.answer).toBe("MERGED: Brio conducts agents from many vendors.");
    expect(t.route?.mode).toBe("ensemble");
    expect(t.attempts.map((a) => a.role).sort()).toEqual(["candidate", "candidate", "merger"]);
    expect(new Set(t.attempts.map((a) => a.agent))).toEqual(new Set(["gpt", "claude"]));
    expect(t.costUsd).toBeGreaterThan(0);
    expect((await view()).chat.title).toBe("What is Brio?");
  });

  it("carries the conversation into the next message, quoted, and takes one message at a time", {
    timeout: 120_000,
  }, async () => {
    const r = await c.request("POST", `/v1/chats/${chatId}/messages`, {
      message: "Say it in one line, take your time",
      agentIds: [gpt],
    });
    expect(r.statusCode, r.body).toBe(202);
    const busy = await c.request("POST", `/v1/chats/${chatId}/messages`, { message: "and another" });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toBe("turn_in_progress");
    // Stopped while the agent works: no retry, and the chat takes the next message.
    const turn = r.json().turn.id;
    const until = Date.now() + 30_000;
    while (!vendors.calls.some((x) => x.body.includes("take your time"))) {
      if (Date.now() > until) throw new Error("the agent never started");
      await new Promise((r) => setTimeout(r, 100));
    }
    const call = vendors.calls.find((x) => x.body.includes("take your time"))!;
    expect(call.body).toContain("MERGED: Brio conducts agents");
    expect(call.body).toContain("untrusted content");
    const stop = await c.request("POST", `/v1/chats/${chatId}/turns/${turn}/stop`);
    expect(stop.json()).toEqual({ stopped: true });
    releaseSlow();
    const t = await settled(1);
    expect(t.status).toBe("cancelled");
    expect(t.error).toBe("stopped");
  });

  it("keeps the chat open after a reply fails, and answers the next one", { timeout: 120_000 }, async () => {
    refusing = true;
    const r = await c.request("POST", `/v1/chats/${chatId}/messages`, {
      message: "please fail",
      agentIds: [claude],
    });
    expect(r.statusCode, r.body).toBe(202);
    const failed = await settled(2);
    refusing = false;
    expect(failed.status).toBe("failed");
    expect(failed.error).toBeTruthy();
    const next = await c.request("POST", `/v1/chats/${chatId}/messages`, {
      message: "Thanks!",
      agentIds: [claude],
    });
    expect(next.statusCode, next.body).toBe(202);
    const t = await settled(3);
    expect(t.status).toBe("done");
    expect(t.answer).toBe("Answer B: a conductor.");
    const [m] = await h.db.db.select().from(schema.missions).where(eq(schema.missions.id, chatId));
    expect(m?.status).toBe("running");
    const types = (await readEventsSince(h.db.db, chatId, 0, 10_000)).map((e) => e.type);
    expect(types).toContain("chat.message");
    expect(types).not.toContain("mission.done");
    expect(types).not.toContain("mission.failed");
  });

  it("lists chats apart from missions, and hands a chat to a full mission", { timeout: 60_000 }, async () => {
    const chats = (await c.request("GET", "/v1/chats")).json().chats as Array<{ id: string; title: string }>;
    expect(chats.map((x) => x.id)).toEqual([chatId]);
    const listed = (await c.request("GET", "/v1/missions")).json().missions as Array<{ id: string }>;
    expect(listed.map((x) => x.id)).not.toContain(chatId);

    const r = await c.request("POST", `/v1/chats/${chatId}/mission`, {
      goal: "Build a landing page for Brio",
    });
    expect(r.statusCode, r.body).toBe(201);
    const [m] = await h.db.db
      .select()
      .from(schema.missions)
      .where(eq(schema.missions.id, r.json().mission.id));
    expect(m?.kind).toBe("mission");
    expect(m?.title).toBe("Build a landing page for Brio");
    expect(m?.goal).toContain("Context from the chat");
    expect(m?.goal).toContain("MERGED: Brio conducts agents");

    const archived = await c.request("DELETE", `/v1/chats/${chatId}`);
    expect(archived.statusCode).toBe(204);
    expect((await c.request("GET", "/v1/chats")).json().chats).toEqual([]);
  });

  it("keeps chats to their workspace", async () => {
    const other = new Client(h);
    await other.signIn("outsider-chat@example.com");
    await other.request("POST", "/v1/workspaces", { name: "Elsewhere" });
    // Another workspace's chat does not exist, as far as an outsider can tell.
    expect((await other.request("GET", `/v1/chats/${chatId}`)).statusCode).toBe(404);
    expect((await other.request("POST", `/v1/chats/${chatId}/messages`, { message: "hi" })).statusCode).toBe(
      404,
    );
  });
});
