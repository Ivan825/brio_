// Cursor Agent CLI, verified against 2026.10.22's --help. Headless needs -p --trust (or it waits for workspace trust)
// and --force to write. Cursor reports no tokens or cost (it bills the user's Cursor plan), so runs are unmetered and
// bounded by time (D-37). Its default config attributes commits to the agent; Brio makes the commits, but the setting
// is turned off anyway (CLAUDE.md rule 9).
import { createCliAdapter } from "./base";
import { mcpServersJson } from "./mcp";
import { arr, editedPath, obj, relative, str } from "./util";

const CLI_CONFIG = JSON.stringify({
  version: 1,
  attribution: { attributeCommitsToAgent: false, attributePRsToAgent: false },
});

export const cursorAgent = createCliAdapter({
  key: "cursor-agent",
  connector: "cursor-agent",
  // A Cursor key is not a model-API key: it cannot be checked or priced through a vendor preset. The preset only gives
  // the connector its shape; runs are unmetered and the key is checked by the first run.
  vendorPreset: "openai",
  keyCheck: "on-first-run",
  credentialEnv: ["CURSOR_API_KEY"],
  egressHosts: ["api2.cursor.sh", "api3.cursor.sh", "api.cursor.com"],
  image: "cli",
  promptVia: "arg",
  unmetered: true,
  argv: (prompt, config) => [
    "sh",
    "-c",
    'mkdir -p "$HOME/.cursor" && printf "%s" "$1" > "$HOME/.cursor/cli-config.json" && if [ -n "$BRIO_MCP_JSON" ]; then printf "%s" "$BRIO_MCP_JSON" > "$HOME/.cursor/mcp.json"; fi && shift && exec cursor-agent "$@"',
    "sh",
    CLI_CONFIG,
    "-p",
    "--output-format",
    "stream-json",
    "--force",
    "--trust",
    "--approve-mcps",
    "--sandbox",
    "disabled",
    "--workspace",
    "/work",
    "--model",
    config.model,
    prompt,
  ],
  mcp: (servers) => ({ env: { BRIO_MCP_JSON: mcpServersJson(servers) } }),
  parse(e, state) {
    if (e.type === "system" && e.subtype === "init") {
      state.sessionId = str(e.session_id) || state.sessionId;
      return [];
    }
    if (e.type === "assistant") {
      const text = arr(obj(e.message).content)
        .map((c) => str(c.text))
        .join("");
      if (!text) return [];
      state.text = text;
      return [{ kind: "message", role: "assistant", text }];
    }
    if (e.type === "tool_call" && e.subtype === "started") {
      const call = obj(e.tool_call);
      const [kind] = Object.keys(call);
      const body = obj(kind ? call[kind] : undefined);
      const args = obj(body.args);
      const fn = obj(call.function);
      const name = kind === "function" ? str(fn.name) : (kind ?? "tool").replace(/ToolCall$/, "");
      const out = [{ kind: "tool_call" as const, name, args: kind === "function" ? fn.arguments : args }];
      const path = kind === "writeToolCall" || kind === "editToolCall" ? editedPath(args) : null;
      return path
        ? [...out, { kind: "file_edit" as const, path: relative(path), op: "modify" as const }]
        : out;
    }
    if (e.type === "result") {
      state.finished = true;
      state.result = str(e.result) || state.text;
      state.sessionId = str(e.session_id) || state.sessionId;
      if (e.is_error === true) state.error = `cursor-agent: ${str(e.result) || "reported an error"}`;
    }
    return [];
  },
  parseText(line, state) {
    // An invalid key is reported as plain text, not JSON.
    if (/api key is invalid/i.test(line)) state.error = "cursor-agent: the API key is invalid";
    return [];
  },
});
