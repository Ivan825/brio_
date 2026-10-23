// Service connectors (ADAPTER_SPEC §2.4–2.9): hosted agents now; media, research and browsers follow.
import type { AgentAdapter } from "../types";
import { agentcore } from "./hosted/agentcore";
import { claudeManagedAgents } from "./hosted/claude-managed-agents";
import { devin } from "./hosted/devin";
import { foundryAgents } from "./hosted/foundry";
import { geminiManagedAgents } from "./hosted/gemini-managed-agents";
import { jules } from "./hosted/jules";
import { manus } from "./hosted/manus";
import { openaiAgents } from "./hosted/openai-agents";

export const HOSTED_ADAPTERS: readonly AgentAdapter[] = [
  claudeManagedAgents,
  openaiAgents,
  geminiManagedAgents,
  jules,
  devin,
  manus,
  agentcore,
  foundryAgents,
];

export * from "./client";
export { agentcoreText } from "./hosted/agentcore";
export { githubRepo, hostedPrompt, PATCH_FILE } from "./hosted/common";
export * from "./job";
export * from "./sigv4";
