// Google Antigravity CLI (`agy -p`), verified against 1.4.6's --help on 23 Oct 2026. API-key mode needs
// modelProvider "gemini" in its settings file plus GEMINI_API_KEY (without it, agy waits for an OAuth sign-in).
// Headless permission allowlists are ignored and soft-denied runs exit 0 (issue 548), so its exit status is not
// trusted: the result event, the diff and the checks decide. agy's stored OAuth tokens are never used (rule 1).
import { addUsage } from "@brio/core";
import { createCliAdapter } from "./base";
import { editedPath, num, obj, relative, str, usage } from "./util";

const EDIT_TOOLS = new Set([
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "sed_file",
]);
const SETTINGS = JSON.stringify({ modelProvider: "gemini" });

export const antigravity = createCliAdapter({
  key: "antigravity",
  connector: "google-antigravity",
  vendorPreset: "gemini",
  credentialEnv: ["GEMINI_API_KEY"],
  egressHosts: ["generativelanguage.googleapis.com"],
  image: "cli",
  promptVia: "arg",
  exitStatusUntrusted: true,
  argv: (prompt, config, input) => [
    "sh",
    "-c",
    'd="$HOME/.gemini/antigravity-cli" && mkdir -p "$d" && printf "%s" "$1" > "$d/settings.json" && shift && exec agy "$@"',
    "sh",
    SETTINGS,
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--model",
    config.model,
    "--print-timeout",
    `${Math.max(1, Math.ceil(input.limits.maxMinutes))}m`,
    "--add-dir",
    "/work",
  ],
  parse(e, state) {
    if (e.event === "init") {
      state.sessionId = str(e.conversation_id) || state.sessionId;
      return [];
    }
    if (e.event === "step_update") {
      const step = obj(e.step_update);
      if (step.step_type === "agent_response") {
        state.text += str(step.text_delta);
        return step.state === "DONE" && state.text
          ? [{ kind: "message", role: "assistant", text: state.text }]
          : [];
      }
      if (step.step_type === "tool" && step.state !== "DONE") {
        const info = obj(step.tool_info);
        const name = str(step.tool_name) || str(info.name);
        const args = obj(info.parameters);
        const path = EDIT_TOOLS.has(name) ? editedPath(args) : null;
        return [
          { kind: "tool_call", name, args },
          ...(path ? [{ kind: "file_edit" as const, path: relative(path), op: "modify" as const }] : []),
        ];
      }
      return [];
    }
    if (e.event === "result") {
      const r = obj(e.result);
      state.finished = true;
      state.result = str(r.response) || state.text;
      state.sessionId = str(r.conversation_id) || state.sessionId;
      const u = obj(r.usage);
      state.usage = addUsage(
        usage({}),
        usage({
          inputTokens: Math.max(0, num(u.input_tokens) - num(u.cache_read_tokens)),
          cachedInputTokens: num(u.cache_read_tokens),
          outputTokens: num(u.output_tokens) + num(u.thinking_tokens),
          reasoningTokens: num(u.thinking_tokens),
        }),
      );
      if (r.status !== "SUCCESS")
        state.error = `antigravity ${str(r.status).toLowerCase() || "error"}: ${str(r.error) || "no details"}`;
    }
    return [];
  },
});
