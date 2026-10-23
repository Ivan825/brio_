// Research (ADAPTER_SPEC §2.9): research agents that answer with cited reports, and the search and fetch tools every
// agent uses.
export { answerOf, openaiResearch, perplexity, RESEARCH_AGENT_ADAPTERS, reportOf, xaiSearch } from "./agents";
export {
  fetchProvider,
  RESEARCH_TOOL_ADAPTERS,
  RESEARCH_TOOLS,
  searchProvider,
  type ToolBinding,
  type ToolContext,
} from "./tools";
