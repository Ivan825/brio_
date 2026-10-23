// AgentAdapter implementations, one folder per connector family (docs/ADAPTER_SPEC.md).
import { ADAPTERS_BY_FAMILY } from "./api-family-registry";
import { CLI_ADAPTERS } from "./cli/index";
import {
  HOSTED_ADAPTERS,
  MEDIA_ADAPTERS,
  RESEARCH_AGENT_ADAPTERS,
  RESEARCH_TOOL_ADAPTERS,
} from "./services/index";
import type { AgentAdapter } from "./types";

/** Registration: adapter key → adapter. packages/registry checks every planned connector resolves here. */
export const ADAPTERS: Readonly<Record<string, AgentAdapter>> = {
  ...ADAPTERS_BY_FAMILY,
  ...Object.fromEntries(CLI_ADAPTERS.map((a) => [a.key, a])),
  ...Object.fromEntries(HOSTED_ADAPTERS.map((a) => [a.key, a])),
  ...Object.fromEntries(MEDIA_ADAPTERS.map((a) => [a.key, a])),
  ...Object.fromEntries(RESEARCH_AGENT_ADAPTERS.map((a) => [a.key, a])),
  ...Object.fromEntries(RESEARCH_TOOL_ADAPTERS.map((a) => [a.key, a])),
};

export const IMPLEMENTED_FAMILIES: ReadonlySet<string> = new Set(Object.keys(ADAPTERS));

/** The milestone whose adapters must all exist (the registry coverage check runs through it). */
export const ADAPTERS_THROUGH_MILESTONE = "M2";

export function adapterFor(family: string): AgentAdapter | undefined {
  return ADAPTERS[family];
}

export * from "./api-adapter";
export * from "./cli/base";
export { CLI_ADAPTERS } from "./cli/index";
export * from "./dispatch";
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
export * from "./services/index";
export * from "./tool-loop";
export * from "./tools";
export * from "./types";
