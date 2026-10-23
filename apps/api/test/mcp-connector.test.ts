// M7: any MCP server as a tool (PRD F10, ADAPTER_SPEC §2.6). Installing one by URL checks it by listing its tools; it
// cannot be built into an agent itself, but is attached to agents; a model-API agent calls its tool during a task, with
// the server's credential added by the runner and kept out of everything stored. Needs Postgres.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readEventsSince, schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { and, eq, gt } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Client, type Harness, startHarness } from "./helpers";
import { type Reply, ScriptedVendors, taskTitle } from "./vendors";

const TOKEN = ["mcp", "secret", "0123456789abcdefghij"].join("-");

/** An order-lookup MCP server that wants a bearer token. */
async function startOrdersServer() {
  const calls: string[] = [];
  const server: Server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const mcp = new McpServer({ name: "orders", version: "1.0.0" });
    mcp.registerTool(
      "lookup_order",
      { description: "Look up an order's status", inputSchema: { id: z.string() } },
      async ({ id }) => {
        calls.push(id);
        return { content: [{ type: "text", text: `Order ${id}: shipped on Tuesday` }] };
      },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => void transport.close());
    await mcp.connect(transport);
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    calls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const PLAN = {
  tasks: [
    {
      key: "status",
      type: "write.summary",
      title: "Report order 42",
      contract: {
        objective: "Say where order 42 is",
        inputs: [],
        outputs: [{ kind: "doc", description: "the order's status" }],
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
};

function script(call: { body: string; turn: number }): Reply {
  if (taskTitle(call.body) !== "Report order 42") return { text: "?" };
  const tool = /"([a-z0-9_-]+__lookup_order)"/.exec(call.body)?.[1];
  if (call.turn === 1 && tool) return { tools: [{ name: tool, args: { id: "42" } }] };
  const said = /Order 42: shipped on Tuesday/.test(call.body)
    ? "Order 42 shipped on Tuesday."
    : "I could not look it up.";
  return { text: said };
}

describe.skipIf(!hasTestDatabase)("M7: MCP servers as tools", () => {
  const vendors = new ScriptedVendors(script);
  let orders: Awaited<ReturnType<typeof startOrdersServer>>;
  let h: Harness;
  let c: Client;
  let mcpId: string;
  let agentId: string;

  beforeAll(async () => {
    orders = await startOrdersServer();
    // Vendor calls go to the script; the MCP server is real, on this machine.
    h = await startHarness({
      fetch: (input, init) =>
        String(input).startsWith("http://127.0.0.1") ? fetch(input, init) : vendors.fetch(input, init),
    });
    c = new Client(h);
    await c.signIn("mcp-tools@example.com");
    await c.request("POST", "/v1/workspaces", { name: "Tools" });
  });
  afterAll(async () => {
    await h?.close();
    await orders?.close();
  });

  it("installs an MCP server by URL and checks it by listing its tools; it is not an agent", async () => {
    const bad = await c.request("POST", "/v1/connectors", {
      registryKey: "model-context-protocol",
      service: "mcp",
      settings: { url: orders.url },
      apiKey: "wrong-token-0123456789",
    });
    expect(bad.json().connector.health).toMatchObject({ ok: false, code: "auth" });
    const res = await c.request("POST", "/v1/connectors", {
      registryKey: "model-context-protocol",
      service: "mcp",
      settings: { url: orders.url },
      apiKey: TOKEN,
      displayName: "Orders",
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().connector.health).toMatchObject({ ok: true, detail: "1 tool" });
    mcpId = res.json().connector.id;
    const a = await c.request("POST", "/v1/agents", { connectorId: mcpId, name: "nope", model: "x" });
    expect(a.json().error).toBe("tool_connector");
  });

  it("gives an agent the server's tools: it looks the order up during its task", async () => {
    const openai = (
      await c.request("POST", "/v1/connectors", {
        registryKey: "openai-api",
        apiKey: ["sk", "tools0123456789abcdefgh"].join("-"),
      })
    ).json().connector;
    const price = { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null };
    const notMcp = await c.request("POST", "/v1/agents", {
      connectorId: openai.id,
      name: "x",
      model: "gpt-coder",
      tools: [{ connectorId: openai.id }],
    });
    expect(notMcp.json().error).toBe("not_a_tool");
    const a = await c.request("POST", "/v1/agents", {
      connectorId: openai.id,
      name: "support",
      model: "gpt-coder",
      priceOverride: price,
      tools: [{ connectorId: mcpId }],
    });
    expect(a.statusCode, a.body).toBe(201);
    agentId = a.json().agent.id;

    const m = await c.request("POST", "/v1/missions", {
      goal: "Order 42?",
      plan: PLAN,
      routing: { strategy: "single", agentId },
    });
    const id = m.json().mission.id as string;
    expect((await c.request("POST", `/v1/missions/${id}/plans/1/approve`)).statusCode).toBe(200);
    for (let i = 0; i < 300; i++) {
      const [row] = await h.db.db.select().from(schema.missions).where(eq(schema.missions.id, id));
      if (row?.status === "done") break;
      if (row?.status === "failed") throw new Error(`mission failed: ${row.blockedReason}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(orders.calls).toEqual(["42"]);
    const [task] = await h.db.db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.missionId, id), gt(schema.tasks.planVersion, 0)));
    const [attempt] = await h.db.db
      .select()
      .from(schema.attempts)
      .where(eq(schema.attempts.taskId, task!.id));
    expect((await c.request("GET", `/v1/attempts/${attempt!.id}/output`)).body).toContain(
      "Order 42 shipped on Tuesday.",
    );
    // Named in the dispatch, never with its token; the token is in no event either.
    expect((attempt?.dispatch as { mcp?: unknown[] } | undefined)?.mcp).toEqual([
      { connectorId: mcpId, name: "orders", url: orders.url, credentialRef: expect.any(String) },
    ]);
    expect(JSON.stringify(attempt?.dispatch)).not.toContain(TOKEN);
    const events = await readEventsSince(h.db.db, id, 0, 1000);
    expect(JSON.stringify(events)).not.toContain(TOKEN);
    expect(
      events.some(
        (e) => e.type === "attempt.tool_call" && JSON.stringify(e.payload).includes("lookup_order"),
      ),
    ).toBe(true);
  }, 120_000);
});
