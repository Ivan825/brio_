// Aider (`aider --message`), verified against 0.86.2's --help on 23 Oct 2026. It has no structured output: messages
// are its text lines, file edits come from the runner's diff, and cost from its "Cost: … session" line. Its own commits
// and "(aider)" attribution are off; Brio makes the commits (CLAUDE.md rule 9).
import { createCliAdapter } from "./base";
import { usage } from "./util";

const TOKENS =
  /Tokens:\s*([\d.,]+)(k?)\s*sent,\s*([\d.,]+)(k?)\s*received\.\s*Cost:\s*\$([\d.]+)\s*message,\s*\$([\d.]+)\s*session/i;
const n = (v: string, k: string) => Math.round(Number(v.replaceAll(",", "")) * (k ? 1000 : 1));

export const aider = createCliAdapter({
  key: "aider",
  connector: "aider",
  vendorPreset: "anthropic",
  credentialEnv: ["ANTHROPIC_API_KEY"],
  env: { AIDER_ANALYTICS_DISABLE: "1", AIDER_CHECK_UPDATE: "false", LITELLM_LOCAL_MODEL_COST_MAP: "True" },
  egressHosts: ["api.anthropic.com"],
  image: "cli",
  promptVia: "arg",
  reportsCost: true,
  argv: (prompt, config) => [
    "aider",
    "--model",
    `anthropic/${config.model}`,
    "--message",
    prompt,
    "--yes-always",
    "--no-auto-commits",
    "--no-dirty-commits",
    "--no-attribute-author",
    "--no-attribute-committer",
    "--no-check-update",
    "--analytics-disable",
    "--no-show-release-notes",
    "--no-pretty",
    "--no-stream",
    "--no-fancy-input",
    "--no-detect-urls",
    "--no-suggest-shell-commands",
    "--no-show-model-warnings",
    "--no-gitignore",
  ],
  parse: () => [],
  parseText(line, state) {
    const m = TOKENS.exec(line);
    if (m) {
      const [, sent = "0", sk = "", recv = "0", rk = "", , session = "0"] = m;
      state.usage = usage({ inputTokens: n(sent, sk), outputTokens: n(recv, rk) });
      state.vendorCostUsd = Number(session);
      state.finished = true;
      return [];
    }
    if (/AuthenticationError|Incorrect API key|invalid x-api-key/i.test(line))
      state.error = `aider: ${line.slice(0, 300)}`;
    if (/^(Aider v|Main model:|Repo-map:|Git repo:|Weak model:)/.test(line))
      return [{ kind: "progress", note: line }];
    state.text = state.text ? `${state.text}\n${line}` : line;
    state.result = state.text;
    return [];
  },
});
