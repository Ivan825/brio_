// M7: Brio as an MCP server. An MCP client (the official SDK, as Claude Code, Cursor or Codex would connect) calls
// brio.delegate with a workspace API token; Brio plans the goal, routes the pieces to agents of two vendors, verifies
// them and the report comes back in the tool result. The other tools read the mission; tokens are held to their
// workspace. Needs Postgres.

import { proxyOptionsFromEnv, runMcpProxy } from "@brio/cli";
import { hasTestDatabase } from "@brio/db/testing";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";
import { type Reply, ScriptedVendors, taskTitle } from "./vendors";

const doc = (key: string, type: string, title: string) => ({
  key,
  type,
  title,
  contract: {
    objective: title,
    inputs: [],
    outputs: [{ kind: "doc", description: title }],
    acceptance: [{ kind: "diff_scope", hard: true }],
    constraints: [],
    sensitivity: "internal",
  },
  dependsOn: [],
  suggestedMode: "single",
});
const PLAN = {
  tasks: [
    doc("research", "write.summary", "Summarise what agent orchestrators do"),
    { ...doc("notes", "write.doc", "Write the team notes"), dependsOn: ["research"] },
  ],
  assumptions: [],
  questions: [],
};

function script(call: { model: string; body: string }): Reply {
  if (call.model === "planner") return { text: `\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\`` };
  const title = taskTitle(call.body);
  if (title === "Summarise what agent orchestrators do")
    return { text: "They plan, route, coordinate and verify." };
  if (title === "Write the team notes") return { text: "Notes: Brio plans, routes and verifies." };
  return { text: "?" };
}

const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";

describe.skipIf(!hasTestDatabase)("M7: Brio as an MCP server", () => {
  const vendors = new ScriptedVendors(script);
  let h: Harness;
  let c: Client;
  let url: URL;
  let token: string;
  let mcp: McpClient;
  let missionId: string;

  const connect = async (authorization?: string) => {
    const client = new McpClient({ name: "claude-code-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: authorization ? { Authorization: authorization } : {} },
      }),
    );
    return client;
  };

  beforeAll(async () => {
    h = await startHarness({ fetch: vendors.fetch });
    c = new Client(h);
    await c.signIn("mcp@example.com");
    await c.request("POST", "/v1/workspaces", { name: "MCP" });
    const price = { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null };
    const openai = (
      await c.request("POST", "/v1/connectors", {
        registryKey: "openai-api",
        apiKey: ["sk", "mcp0123456789abcdefghij"].join("-"),
      })
    ).json().connector;
    const anthropic = (
      await c.request("POST", "/v1/connectors", {
        registryKey: "claude-api",
        apiKey: ["sk", "ant", "mcp0123456789abcdef"].join("-"),
      })
    ).json().connector;
    await c.request("POST", "/v1/agents", {
      connectorId: openai.id,
      name: "planner",
      model: "planner",
      priceOverride: price,
    });
    await c.request("POST", "/v1/agents", {
      connectorId: anthropic.id,
      name: "writer",
      model: "claude-writer",
      priceOverride: price,
    });
    token = (await c.request("POST", "/v1/tokens", { name: "claude code" })).json().token.value;
    url = new URL(`${await h.server.app.listen({ port: 0, host: "127.0.0.1" })}/mcp`);
    mcp = await connect(`Bearer ${token}`);
  });
  afterAll(async () => {
    await mcp?.close();
    await h?.close();
  });

  it("offers Brio's tools", async () => {
    const names = (await mcp.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "answer",
        "approve_plan",
        "ask_agent",
        "delegate",
        "get_brief",
        "get_contract",
        "list_missions",
        "mission_status",
        "plan_mission",
        "report",
        "request_review",
      ].sort(),
    );
  });

  it("delegates a goal and returns the verified report", async () => {
    const r = await mcp.callTool(
      { name: "delegate", arguments: { task: "Explain agent orchestration for the team", wait_minutes: 3 } },
      undefined,
      { timeout: 240_000 },
    );
    const report = textOf(r);
    expect((r as { isError?: boolean }).isError).toBeFalsy();
    expect(report).toContain("research");
    expect(report).toContain("notes");
    expect(report).toMatch(/done/i);
    const list = textOf(await mcp.callTool({ name: "list_missions", arguments: {} }));
    missionId = /^- ([0-9a-f-]{36}) done:/m.exec(list)?.[1] ?? "";
    expect(missionId).not.toBe("");
  }, 300_000);

  it("reads the mission back: status, brief and report", async () => {
    const status = textOf(
      await mcp.callTool({ name: "mission_status", arguments: { mission_id: missionId } }),
    );
    expect(status).toMatch(/— done/);
    expect(status).toContain("- research (write.summary): done");
    const brief = textOf(await mcp.callTool({ name: "get_brief", arguments: { mission_id: missionId } }));
    expect(brief).toContain("Goal: Explain agent orchestration for the team");
    expect(brief).toContain("Done: ");
    const review = textOf(
      await mcp.callTool({
        name: "request_review",
        arguments: { mission_id: missionId, note: "Check the notes' tone" },
      }),
    );
    expect(review).toMatch(/^Review requested/);
  });

  it("refuses missing or bad tokens, and keeps a token to its workspace", async () => {
    await expect(connect()).rejects.toThrow();
    await expect(connect(`Bearer brio_pat_${"x".repeat(40)}`)).rejects.toThrow();
    await c.request("POST", "/v1/workspaces", { name: "Elsewhere" });
    const other = (await c.request("POST", "/v1/tokens", { name: "other" })).json().token.value;
    const elsewhere = await connect(`Bearer ${other}`);
    const r = await elsewhere.callTool({ name: "mission_status", arguments: { mission_id: missionId } });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(textOf(r)).toBe("mission not found");
    await elsewhere.close();
  });

  it("serves the same tools over stdio through `brio mcp` (here, an in-memory pair)", async () => {
    expect(() => proxyOptionsFromEnv({})).toThrow(/BRIO_TOKEN/);
    const opts = proxyOptionsFromEnv({ BRIO_URL: url.origin, BRIO_TOKEN: token });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const proxy = await runMcpProxy(opts, serverSide);
    const local = new McpClient({ name: "stdio-client", version: "1.0.0" });
    await local.connect(clientSide);
    expect((await local.listTools()).tools.map((t) => t.name)).toContain("delegate");
    const status = textOf(
      await local.callTool({ name: "mission_status", arguments: { mission_id: missionId } }),
    );
    expect(status).toMatch(/— done/);
    await local.close();
    await proxy.close();
  });
});
