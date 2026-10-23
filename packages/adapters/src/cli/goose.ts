// Goose (`goose run --output-format stream-json`), verified against 1.55.0's --help on 23 Oct 2026 (the project moved
// to aaif-goose/goose). --no-profile ignores local config, so the developer extension is added explicitly; on failure
// there is no "complete" event, only an error.
import { createCliAdapter } from "./base";
import { arr, editedPath, num, obj, relative, str, usage } from "./util";

export const goose = createCliAdapter({
  key: "goose",
  connector: "goose-openhands",
  vendorPreset: "anthropic",
  credentialEnv: ["ANTHROPIC_API_KEY"],
  env: {
    GOOSE_MODE: "auto",
    GOOSE_DISABLE_KEYRING: "1",
    GOOSE_TELEMETRY_ENABLED: "false",
    GOOSE_DISABLE_SESSION_NAMING: "1",
  },
  egressHosts: ["api.anthropic.com"],
  image: "cli",
  promptVia: "arg",
  argv: (prompt, config, input) => [
    "goose",
    "run",
    "--no-session",
    "--quiet",
    "--output-format",
    "stream-json",
    "--provider",
    "anthropic",
    "--model",
    config.model,
    "--max-turns",
    String(input.limits.maxTurns ?? 50),
    "--no-profile",
    "--with-builtin",
    "developer",
    "--text",
    prompt,
  ],
  parse(e, state) {
    if (e.type === "message") {
      const m = obj(e.message);
      if (m.role !== "assistant") return [];
      const out = [];
      for (const c of arr(m.content)) {
        if (c.type === "text" && str(c.text)) {
          state.text = str(c.text);
          out.push({ kind: "message" as const, role: "assistant" as const, text: state.text });
        } else if (c.type === "toolRequest") {
          const value = obj(obj(c.toolCall).value);
          const name = str(value.name);
          const args = obj(value.arguments);
          out.push({ kind: "tool_call" as const, name, args });
          const path = name.endsWith("text_editor") ? editedPath(args) : null;
          if (path && args.command !== "view")
            out.push({ kind: "file_edit" as const, path: relative(path), op: "modify" as const });
        } else if (c.type === "error") state.error = `goose: ${str(c.message)}`;
      }
      return out;
    }
    if (e.type === "complete") {
      state.finished = true;
      state.result = state.text;
      state.usage = usage({
        inputTokens: num(e.input_tokens),
        cachedInputTokens: num(e.cache_read_input_tokens),
        cacheWriteTokens: num(e.cache_write_input_tokens),
        outputTokens: num(e.output_tokens),
      });
      if (typeof e.cost_usd === "number") state.vendorCostUsd = num(e.cost_usd);
      return [];
    }
    if (e.type === "error") state.error = `goose: ${str(e.error)}`;
    return [];
  },
});
