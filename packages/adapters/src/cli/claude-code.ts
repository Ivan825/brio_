// Claude Code headless (`claude -p`), verified against 2.1.309's --help on 23 Oct 2026. stream-json requires --verbose;
// -p starts in manual permission mode, so unattended edits need bypassPermissions (refused as root; sandboxes are not).
// An API failure arrives as subtype "success" with is_error true, so is_error decides.
import { type CliState, createCliAdapter } from "./base";
import { arr, editedPath, num, obj, relative, str, usage } from "./util";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export const claudeCode = createCliAdapter({
  key: "claude-code",
  connector: "claude-code",
  vendorPreset: "anthropic",
  credentialEnv: ["ANTHROPIC_API_KEY"],
  env: {
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_FEEDBACK_COMMAND: "1",
  },
  egressHosts: ["api.anthropic.com"],
  image: "cli",
  promptVia: "stdin",
  reportsCost: true,
  argv: (_prompt, config, input) => [
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--model",
    config.model,
    "--max-turns",
    String(input.limits.maxTurns ?? 50),
    "--max-budget-usd",
    String(input.limits.maxCostUsd),
    // No user, project or local settings: a repository cannot bring its own hooks or MCP servers.
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--no-session-persistence",
  ],
  parse(e, state: CliState) {
    if (e.type === "system" && e.subtype === "init") {
      state.sessionId = str(e.session_id) || state.sessionId;
      return [{ kind: "progress", note: `claude-code ${str(e.claude_code_version)} · ${str(e.model)}` }];
    }
    if (e.type === "assistant") {
      const out = [];
      for (const block of arr(obj(e.message).content)) {
        if (block.type === "text" && str(block.text)) {
          state.text = str(block.text);
          out.push({ kind: "message" as const, role: "assistant" as const, text: state.text });
        } else if (block.type === "tool_use") {
          const name = str(block.name);
          const input = obj(block.input);
          out.push({ kind: "tool_call" as const, name, args: input });
          const path = EDIT_TOOLS.has(name) ? editedPath(input) : null;
          if (path)
            out.push({
              kind: "file_edit" as const,
              path: relative(path),
              op: name === "Write" ? ("create" as const) : ("modify" as const),
            });
        }
      }
      return out;
    }
    if (e.type === "result") {
      state.finished = true;
      state.result = str(e.result) || state.text;
      state.sessionId = str(e.session_id) || state.sessionId;
      const u = obj(e.usage);
      state.usage = usage({
        inputTokens: num(u.input_tokens),
        cachedInputTokens: num(u.cache_read_input_tokens),
        cacheWriteTokens: num(u.cache_creation_input_tokens),
        outputTokens: num(u.output_tokens),
      });
      if (typeof e.total_cost_usd === "number") state.vendorCostUsd = num(e.total_cost_usd);
      if (e.is_error === true || (e.subtype !== "success" && e.subtype !== undefined))
        state.error = `${str(e.subtype) || "error"}: ${str(e.result) || str(e.terminal_reason) || "claude-code reported an error"}`;
    }
    return [];
  },
});
