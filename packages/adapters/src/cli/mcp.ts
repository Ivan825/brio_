// MCP server configs in each CLI's own format (verified against each CLI's docs on 23 Oct 2026).
import type { McpServerConfig } from "../types";

const http = (servers: McpServerConfig[]) => servers.filter((s) => s.transport === "http" && s.url);

/** Claude Code and Cursor: { mcpServers: { name: { type: "http", url, headers } } }. */
export function mcpServersJson(servers: McpServerConfig[]): string {
  return JSON.stringify({
    mcpServers: Object.fromEntries(
      http(servers).map((s) => [s.name, { type: "http", url: s.url, headers: s.headers ?? {} }]),
    ),
  });
}

/** OpenCode: { mcp: { name: { type: "remote", url, headers, enabled } } }, given through OPENCODE_CONFIG_CONTENT. */
export function opencodeConfig(servers: McpServerConfig[]): string {
  return JSON.stringify({
    mcp: Object.fromEntries(
      http(servers).map((s) => [
        s.name,
        { type: "remote", url: s.url, headers: s.headers ?? {}, enabled: true },
      ]),
    ),
  });
}

/** Codex: -c mcp_servers.<id>.url=… with the bearer token taken from an environment variable. */
export function codexMcp(servers: McpServerConfig[]): { args: string[]; env: Record<string, string> } {
  const args: string[] = [];
  const env: Record<string, string> = {};
  for (const s of http(servers)) {
    const id = s.name.replace(/[^a-zA-Z0-9_]/g, "_");
    args.push("-c", `mcp_servers.${id}.url=${JSON.stringify(s.url)}`);
    const token = /^Bearer (.+)$/.exec(s.headers?.Authorization ?? s.headers?.authorization ?? "")?.[1];
    if (token) {
      const v = `BRIO_MCP_${id.toUpperCase()}_TOKEN`;
      env[v] = token;
      args.push("-c", `mcp_servers.${id}.bearer_token_env_var=${JSON.stringify(v)}`);
    }
  }
  return { args, env };
}
