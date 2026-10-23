// AgentAdapter implementations, one folder per connector family (docs/ADAPTER_SPEC.md).
import { anthropic } from "./families/anthropic/index";
import { gemini } from "./families/gemini/index";
import { openaiCompatible } from "./families/openai-compatible/index";
import type { AgentAdapter } from "./types";

/** Registration: family key → adapter. packages/registry checks every planned connector resolves here. */
export const ADAPTERS: Readonly<Record<string, AgentAdapter>> = {
  [openaiCompatible.key]: openaiCompatible,
  [anthropic.key]: anthropic,
  [gemini.key]: gemini,
};

export const IMPLEMENTED_FAMILIES: ReadonlySet<string> = new Set(Object.keys(ADAPTERS));

/** The milestone whose adapters must all exist (the registry coverage check runs through it). */
export const ADAPTERS_THROUGH_MILESTONE = "M1";

export function adapterFor(family: string): AgentAdapter | undefined {
  return ADAPTERS[family];
}

export * from "./api-adapter";
export * from "./errors";
export { anthropicUsage, parseMessage } from "./families/anthropic/index";
export { geminiUsage, parseGenerateContent } from "./families/gemini/index";
export {
  chatUsage,
  parseChatResponse,
  parseResponsesResponse,
  responsesUsage,
  vendorCost,
} from "./families/openai-compatible/index";
export * from "./http";
export * from "./logger";
export * from "./models";
export * from "./net";
export * from "./tool-loop";
export * from "./tools";
export * from "./types";
