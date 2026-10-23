// `brio mcp`: Brio's MCP tools over stdio, for MCP clients that launch local servers (Claude Code, Cursor, Codex). It
// forwards every tool list and call to the Brio server's /mcp with the workspace API token from the environment
// (MCP: stdio servers take credentials from the environment), so the tools and their rules are exactly the remote ones.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface ProxyOptions {
  /** The Brio server (web or API origin), e.g. https://brio.example. */
  url: string;
  /** A workspace API token (brio_pat_…). */
  token: string;
  fetch?: typeof fetch;
}

/** Reads BRIO_URL and BRIO_TOKEN; says what is missing instead of starting half-configured. */
export function proxyOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ProxyOptions {
  const url = env.BRIO_URL ?? "http://localhost:4000";
  const token = env.BRIO_TOKEN ?? "";
  if (!token.startsWith("brio_pat_"))
    throw new Error("set BRIO_TOKEN to a workspace API token (Settings → API tokens in the Brio web app)");
  return { url, token };
}

/** Connects to Brio, then serves its tools on `local` until the client goes away. */
export async function runMcpProxy(
  o: ProxyOptions,
  local: Transport,
): Promise<{ close: () => Promise<void> }> {
  const remote = new Client({ name: "brio-cli", version: "1.0.0" });
  await remote.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", o.url), {
      requestInit: { headers: { Authorization: `Bearer ${o.token}` } },
      ...(o.fetch ? { fetch: o.fetch } : {}),
    }),
  );
  const server = new Server({ name: "brio", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async (req) => remote.listTools(req.params));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) =>
    // Delegations can run for an hour; the remote tool decides how long to wait.
    remote.callTool(req.params, undefined, {
      signal: extra.signal,
      timeout: 65 * 60_000,
      resetTimeoutOnProgress: true,
    }),
  );
  await server.connect(local);
  return {
    close: async () => {
      await server.close();
      await remote.close();
    },
  };
}
