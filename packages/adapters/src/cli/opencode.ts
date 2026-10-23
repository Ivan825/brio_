// OpenCode (`opencode run --format json`), verified against 1.19.4's --help on 23 Oct 2026. Model-agnostic; Brio runs
// it through OpenRouter (one key, any model, cost reported per step). --pure skips external plugins; it reads no
// Claude Code files.
import { addUsage } from "@brio/core";
import { createCliAdapter } from "./base";
import { editedPath, num, obj, relative, str, usage } from "./util";

const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit"]);

export const opencode = createCliAdapter({
  key: "opencode",
  connector: "opencode",
  vendorPreset: "openrouter",
  credentialEnv: ["OPENROUTER_API_KEY"],
  env: { OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1" },
  // models.dev is OpenCode's model catalogue, needed to resolve model ids.
  egressHosts: ["openrouter.ai", "models.dev"],
  image: "cli",
  promptVia: "arg",
  reportsCost: true,
  argv: (prompt, config) => [
    "opencode",
    "run",
    "--format",
    "json",
    "--auto",
    "--pure",
    "--model",
    `openrouter/${config.model}`,
    "--dir",
    "/work",
    prompt,
  ],
  parse(e, state) {
    state.sessionId = str(e.sessionID) || state.sessionId;
    const part = obj(e.part);
    switch (e.type) {
      case "text": {
        const text = str(part.text) || str(e.text);
        if (!text) return [];
        state.text = text;
        state.finished = true;
        return [{ kind: "message", role: "assistant", text }];
      }
      case "tool_use": {
        const tool = str(part.tool);
        const input = obj(obj(part.state).input);
        const path = EDIT_TOOLS.has(tool) ? editedPath(input) : null;
        return [
          { kind: "tool_call", name: tool, args: input },
          ...(path
            ? [
                {
                  kind: "file_edit" as const,
                  path: relative(path),
                  op: tool === "write" ? ("create" as const) : ("modify" as const),
                },
              ]
            : []),
        ];
      }
      case "step_finish": {
        const t = obj(part.tokens);
        const cache = obj(t.cache);
        state.usage = addUsage(
          state.usage,
          usage({
            inputTokens: num(t.input),
            cachedInputTokens: num(cache.read),
            cacheWriteTokens: num(cache.write),
            outputTokens: num(t.output) + num(t.reasoning),
            reasoningTokens: num(t.reasoning),
          }),
        );
        state.vendorCostUsd = (state.vendorCostUsd ?? 0) + num(part.cost);
        return [];
      }
      case "error": {
        const err = obj(e.error);
        state.error = `opencode: ${str(obj(err.data).message) || str(err.name) || "error"}`;
        return [];
      }
      default:
        return [];
    }
  },
});
