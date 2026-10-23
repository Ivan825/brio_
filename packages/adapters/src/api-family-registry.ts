// The model-API families, apart from the CLI adapters so CLI adapters can delegate key checks and model lists to their
// vendor's family without an import cycle.
import { anthropic } from "./families/anthropic/index";
import { gemini } from "./families/gemini/index";
import { openaiCompatible } from "./families/openai-compatible/index";
import type { AgentAdapter } from "./types";

export const ADAPTERS_BY_FAMILY: Readonly<Record<string, AgentAdapter>> = {
  [openaiCompatible.key]: openaiCompatible,
  [anthropic.key]: anthropic,
  [gemini.key]: gemini,
};
