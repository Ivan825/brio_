// OpenAI Codex CLI (`codex exec --json`), verified against 0.164.0's --help on 23 Oct 2026. The container is the
// sandbox, so Codex's own sandbox and approvals are bypassed. Only turn.failed is fatal; item "error"s are warnings.
// Codex reports tokens per turn but no cost: cost comes from the OpenAI price table.
import { addUsage } from "@brio/core";
import { createCliAdapter } from "./base";
import { codexMcp } from "./mcp";
import { arr, num, obj, relative, str, usage } from "./util";

export const codex = createCliAdapter({
  key: "codex",
  connector: "openai-codex",
  vendorPreset: "openai",
  credentialEnv: ["CODEX_API_KEY"],
  env: { CODEX_HOME: "/home/brio/.codex" },
  egressHosts: ["api.openai.com"],
  image: "cli",
  promptVia: "arg",
  argv: (prompt, config) => [
    "codex",
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--dangerously-bypass-approvals-and-sandbox",
    "--model",
    config.model,
    "--cd",
    "/work",
    "-c",
    "check_for_update_on_startup=false",
    "-c",
    "analytics.enabled=false",
    "-c",
    "feedback.enabled=false",
    prompt,
  ],
  mcp: (servers) => {
    const { args, env } = codexMcp(servers);
    // The prompt stays the last argument.
    return { env, argv: (argv) => [...argv.slice(0, -1), ...args, argv.at(-1) as string] };
  },
  parse(e, state) {
    switch (e.type) {
      case "thread.started":
        state.sessionId = str(e.thread_id);
        return [];
      case "item.started":
      case "item.completed": {
        const item = obj(e.item);
        if (item.type === "agent_message" && e.type === "item.completed") {
          state.text = str(item.text);
          return [{ kind: "message", role: "assistant", text: state.text }];
        }
        if (item.type === "command_execution" && e.type === "item.started")
          return [{ kind: "tool_call", name: "shell", args: { command: str(item.command) } }];
        if (item.type === "mcp_tool_call" && e.type === "item.started")
          return [{ kind: "tool_call", name: `${str(item.server)}.${str(item.tool)}`, args: item.arguments }];
        if (item.type === "file_change" && e.type === "item.completed")
          return arr(item.changes).map((c) => ({
            kind: "file_edit" as const,
            path: relative(str(c.path)),
            op:
              c.kind === "add"
                ? ("create" as const)
                : c.kind === "delete"
                  ? ("delete" as const)
                  : ("modify" as const),
          }));
        if (item.type === "error") return [{ kind: "progress", note: `codex: ${str(item.message)}` }];
        return [];
      }
      case "turn.completed": {
        const u = obj(e.usage);
        const input = num(u.input_tokens);
        const cached = Math.min(input, num(u.cached_input_tokens));
        const write = Math.min(input - cached, num(u.cache_write_input_tokens));
        state.usage = addUsage(
          state.usage,
          usage({
            inputTokens: input - cached - write,
            cachedInputTokens: cached,
            cacheWriteTokens: write,
            outputTokens: num(u.output_tokens),
            reasoningTokens: num(u.reasoning_output_tokens),
          }),
        );
        state.finished = true;
        state.result = state.text;
        return [];
      }
      case "turn.failed":
        state.error = `codex: ${str(obj(e.error).message) || "the turn failed"}`;
        return [];
      default:
        return [];
    }
  },
});
