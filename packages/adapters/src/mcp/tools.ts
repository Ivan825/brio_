// MCP servers as tools for model-API agents (ADAPTER_SPEC §2.6, PRD F10): each HTTP server attached to the agent is
// opened with the official SDK client through Brio's guarded fetch, its tools are offered to the model as
// `<server>__<tool>`, and calls are forwarded. A server that cannot be reached is left out and said so; nothing is
// offered that would only fail. (Coding CLIs get the same servers through their own MCP configuration.)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AdapterError } from "../errors";
import { serviceBase } from "../services/client";
import { toolAdapter } from "../services/research/tools";
import type { AgentAdapter, FetchLike, McpServerConfig, Tool } from "../types";

const MAX_RESULT = 20_000;

/** A tool name the model APIs accept: letters, digits, _ and -, at most 64 characters. */
export const mcpToolName = (server: string, tool: string) =>
  `${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

/** Text of an MCP tool result (text blocks, and what other blocks are, briefly). */
function resultText(r: {
  content?: Array<{ type: string; text?: string; mimeType?: string }>;
  structuredContent?: unknown;
}): string {
  const parts = (r.content ?? []).map((c) =>
    c.type === "text" ? (c.text ?? "") : `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ""}]`,
  );
  if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
  const t = parts.join("\n");
  return t.length <= MAX_RESULT ? t : `${t.slice(0, MAX_RESULT)}\n…[truncated]`;
}

export interface McpTools {
  tools: Tool[];
  /** Servers that could not be opened, and why. */
  skipped: Array<{ server: string; error: string }>;
  close(): Promise<void>;
}

/** Opens the agent's MCP servers and lists their tools. */
export async function openMcpTools(
  servers: McpServerConfig[],
  o: { fetch: FetchLike; signal: AbortSignal; timeoutMs?: number },
): Promise<McpTools> {
  const clients: Client[] = [];
  const tools: Tool[] = [];
  const skipped: McpTools["skipped"] = [];
  for (const s of servers) {
    if (s.transport !== "http" || !s.url) {
      skipped.push({ server: s.name, error: "only HTTP MCP servers reach model-API agents" });
      continue;
    }
    const client = new Client({ name: "brio", version: "1.0.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(s.url), {
          requestInit: { headers: s.headers ?? {} },
          fetch: ((input: string | URL, init?: RequestInit) =>
            o.fetch(String(input), init ?? {})) as typeof fetch,
        }),
      );
      const listed = await client.listTools(undefined, { signal: o.signal, timeout: o.timeoutMs ?? 30_000 });
      clients.push(client);
      for (const t of listed.tools)
        tools.push({
          name: mcpToolName(s.name, t.name),
          description: `${t.description ?? t.name} (from the ${s.name} MCP server)`.slice(0, 1024),
          parameters: (t.inputSchema ?? { type: "object", properties: {} }) as Tool["parameters"],
          run: async (args, { signal }) => {
            const r = await client.callTool({ name: t.name, arguments: args }, undefined, {
              signal,
              timeout: 5 * 60_000,
            });
            const text = resultText(r as Parameters<typeof resultText>[0]);
            if ((r as { isError?: boolean }).isError)
              throw new AdapterError("bad_request", text || "the tool failed");
            return text || "(no output)";
          },
        });
    } catch (e) {
      // The SDK's HTTP errors carry the status as `code`; name it, so a refused key reads as one.
      const status = (e as { code?: unknown }).code;
      const prefix = typeof status === "number" && status >= 400 ? `HTTP ${status}: ` : "";
      skipped.push({ server: s.name, error: `${prefix}${(e as Error).message}`.slice(0, 300) });
      await client.close().catch(() => {});
    }
  }
  return {
    tools,
    skipped,
    close: async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
    },
  };
}

/** The connector side of an MCP server: its key check lists its tools; it is a tool, never an agent. */
export async function checkMcpServer(server: McpServerConfig, fetch: FetchLike): Promise<number> {
  const m = await openMcpTools([server], { fetch, signal: AbortSignal.timeout(20_000), timeoutMs: 15_000 });
  await m.close();
  if (m.skipped.length)
    throw new AdapterError("network", m.skipped[0]?.error ?? "cannot reach the MCP server");
  return m.tools.length;
}

/**
 * An MCP server as a connector (registry service "mcp"): its key check opens it and lists its tools; it is attached to
 * agents as a tool and is never run as an agent itself.
 */
export const mcpConnector: AgentAdapter = {
  ...toolAdapter({ key: "mcp", kind: "MCP" }),
  route: "mcp",
  async healthCheck(config, ctx) {
    const started = performance.now();
    const token = ctx.credential?.reveal();
    try {
      const n = await checkMcpServer(
        {
          name: "server",
          transport: "http",
          url: serviceBase(config),
          ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
        },
        ctx.fetch,
      );
      return {
        ok: true,
        latencyMs: Math.round(performance.now() - started),
        detail: `${n} tool${n === 1 ? "" : "s"}`,
      };
    } catch (e) {
      const msg = (e as Error).message;
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - started),
        error: msg,
        code: /401|403|unauthori[sz]ed|forbidden/i.test(msg) ? "auth" : "network",
      };
    }
  },
};
