// Research agents (ADAPTER_SPEC §2.9, docs/vendors/research-browser.md §1–3): the Perplexity Agent API, OpenAI's
// Responses API with web search, and xAI's Responses API with web and X search. All three answer in the Responses
// shape — output[] with messages whose text carries url_citation annotations — so one adapter serves them; what
// differs (tools, background mode, where sources and cost are reported) is per vendor. The answer ends with a numbered
// source list so citation and link checks can read it.
import { AdapterError } from "../../errors";
import type { AgentConfig, RunInput } from "../../types";
import type { ServiceClient } from "../client";
import { createJobAdapter, type JobUpdate, type JobUsage } from "../job";

type Annotation = { type?: string; url?: string; title?: string };
type OutputItem = {
  type?: string;
  role?: string;
  content?: Array<{ type?: string; text?: string; annotations?: Annotation[] }>;
  results?: Array<{ id?: number; title?: string; url?: string }>;
  action?: { sources?: Array<{ url?: string; title?: string }> };
};
type Response = {
  id?: string;
  status?: string;
  output?: OutputItem[];
  output_text?: string;
  citations?: string[];
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    cost?: { total_cost?: number };
    server_side_tool_usage?: Record<string, number>;
  };
};

interface Vendor {
  key: string;
  path: string;
  /** Runs in background mode (create, then poll by id); otherwise one long request. */
  background: boolean;
  body(input: RunInput, config: AgentConfig): Record<string, unknown>;
  /** USD for a fee per search call on top of tokens (the service's pricing.perCallUsd). */
  calls?(r: Response): number;
}

export interface Source {
  title: string;
  url: string;
}

/** The answer's text and every source it was given or cites, in order, without duplicates. */
export function answerOf(r: Response): { text: string; sources: Source[] } {
  const items = r.output ?? [];
  const text =
    items
      .filter((o) => o.type === "message")
      .flatMap((o) => o.content ?? [])
      .filter((c) => c.type === "output_text" || c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n")
      .trim() || (r.output_text ?? "").trim();
  const found: Source[] = [];
  const add = (url: string | undefined, title?: string) => {
    if (url && /^https?:\/\//.test(url) && !found.some((s) => s.url === url))
      found.push({ url, title: title || url });
  };
  // Perplexity numbers its [n] markers by search_results ids: keep that order first.
  for (const o of items.filter((x) => x.type === "search_results"))
    for (const res of [...(o.results ?? [])].sort((a, b) => (a.id ?? 0) - (b.id ?? 0)))
      add(res.url, res.title);
  for (const o of items)
    for (const c of o.content ?? [])
      for (const a of c.annotations ?? []) if (a.type === "url_citation") add(a.url, a.title);
  for (const o of items.filter((x) => x.type === "web_search_call"))
    for (const s of o.action?.sources ?? []) add(s.url, s.title);
  for (const url of r.citations ?? []) add(url);
  return { text, sources: found };
}

export function reportOf(r: Response): string {
  const { text, sources } = answerOf(r);
  if (!sources.length) return text;
  return `${text}\n\n## Sources\n${sources.map((s, i) => `${i + 1}. [${s.title.replace(/[[\]]/g, "")}](${s.url})`).join("\n")}`;
}

const prompt = (input: RunInput, config: AgentConfig) =>
  [config.rolePrompt, input.instructions].filter(Boolean).join("\n\n");

const INSTRUCTIONS =
  "Research the task on the web. Cite a source for every factual claim with [n] markers. Say plainly what you could not verify.";

function usageOf(r: Response, config: AgentConfig, vendor: Vendor): JobUsage {
  const u = r.usage ?? {};
  if (u.cost?.total_cost !== undefined)
    return { usd: u.cost.total_cost, tokensIn: u.input_tokens ?? 0, tokensOut: u.output_tokens ?? 0 };
  const tokensIn = u.input_tokens ?? 0;
  const tokensOut = u.output_tokens ?? 0;
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  const fee = (vendor.calls?.(r) ?? 0) * Number(config.connector.service?.pricing.perCallUsd ?? 0);
  if (!config.price) return { tokensIn, tokensOut, cachedTokensIn: cached, ...(fee ? { usd: fee } : {}) };
  const p = config.price;
  const tokensUsd =
    ((tokensIn - cached) * p.inputPerM +
      cached * (p.cachedInputPerM ?? p.inputPerM) +
      tokensOut * p.outputPerM) /
    1e6;
  return { usd: tokensUsd + fee, tokensIn, tokensOut, cachedTokensIn: cached };
}

const countCalls = (r: Response, type: string) => (r.output ?? []).filter((o) => o.type === type).length;

export const perplexityVendor: Vendor = {
  key: "perplexity",
  path: "/v1/agent",
  background: true,
  body: (input, config) => ({
    ...(config.model && config.model !== "auto" ? { model: config.model } : {}),
    input: prompt(input, config),
    instructions: INSTRUCTIONS,
    tools: [{ type: "web_search" }, { type: "fetch_url" }],
    effort:
      typeof config.options?.effort === "string"
        ? config.options.effort
        : input.taskType === "research.deep_report"
          ? "high"
          : "low",
  }),
};

export const openaiResearchVendor: Vendor = {
  key: "openai-research",
  path: "/responses",
  background: true,
  body: (input, config) => ({
    model: config.model,
    input: prompt(input, config),
    instructions: INSTRUCTIONS,
    tools: [
      {
        type: "web_search",
        ...(Array.isArray(config.options?.allowedDomains)
          ? { filters: { allowed_domains: config.options.allowedDomains } }
          : {}),
      },
    ],
    include: ["web_search_call.action.sources"],
    ...(input.taskType === "research.deep_report" ? { reasoning: { effort: "high" } } : {}),
    ...(typeof config.options?.maxToolCalls === "number"
      ? { max_tool_calls: config.options.maxToolCalls }
      : {}),
  }),
  calls: (r) => countCalls(r, "web_search_call"),
};

export const xaiSearchVendor: Vendor = {
  key: "xai-search",
  path: "/responses",
  background: false,
  body: (input, config) => ({
    model: config.model,
    input: [
      { role: "system", content: [config.rolePrompt, INSTRUCTIONS].filter(Boolean).join("\n\n") },
      { role: "user", content: input.instructions },
    ],
    tools: [{ type: "web_search" }, { type: "x_search" }],
  }),
  calls: (r) =>
    Object.values(r.usage?.server_side_tool_usage ?? {}).reduce((s, n) => s + (Number(n) || 0), 0),
};

interface Job {
  id: string;
  /** A synchronous answer, kept until outputs. */
  done: Response | null;
}

const TERMINAL_BAD: Record<string, string> = {
  failed: "failed",
  cancelled: "cancelled",
  incomplete: "failed",
};

function researchAdapter(vendor: Vendor) {
  return createJobAdapter<Job>({
    key: vendor.key,
    route: "api",
    capabilities: () => ({
      taskTypes: [],
      editsFiles: false,
      runsCode: false,
      browses: true,
      producesMedia: [],
      streaming: false,
      supportsMcpTools: false,
      supportsResume: false,
      runnerModes: ["cloud"],
    }),
    estimateUsd: 0.3,
    pollMs: 3000,

    async start(input, config, api) {
      const body = { ...vendor.body(input, config), ...(vendor.background ? { background: true } : {}) };
      const r = await api.json<Response>("POST", vendor.path, body, { retries: 0, timeoutMs: 20 * 60_000 });
      if (!r.id && !vendor.background) return { id: `${vendor.key}-${Date.now()}`, done: r };
      if (!r.id) throw new AdapterError("bad_request", "no response id came back");
      return {
        id: r.id,
        done: vendor.background && !["completed", "failed", "incomplete"].includes(r.status ?? "") ? null : r,
      };
    },

    idOf: (j) => j.id,

    async poll(job, config, api: ServiceClient): Promise<JobUpdate<Job>> {
      const r = job.done ?? (await api.json<Response>("GET", `${vendor.path}/${job.id}`));
      const status = r.status ?? "completed";
      if (TERMINAL_BAD[status])
        return {
          job,
          state: TERMINAL_BAD[status] as "failed" | "cancelled",
          error: r.error?.message ?? r.incomplete_details?.reason ?? `the research ${status}`,
          usage: usageOf(r, config, vendor),
        };
      if (status !== "completed") return { job, state: "running", progress: [status.replace(/_/g, " ")] };
      return { job: { ...job, done: r }, state: "done", usage: usageOf(r, config, vendor) };
    },

    async cancel(job, api) {
      if (vendor.background && !job.done)
        await api.json("POST", `${vendor.path}/${job.id}/cancel`, {}, { retries: 0 });
    },

    async outputs(job) {
      const r = job.done as Response;
      const text = reportOf(r);
      if (!text) throw new AdapterError("bad_request", "the research came back empty");
      return { text };
    },
  });
}

export const perplexity = researchAdapter(perplexityVendor);
export const openaiResearch = researchAdapter(openaiResearchVendor);
export const xaiSearch = researchAdapter(xaiSearchVendor);

export const RESEARCH_AGENT_ADAPTERS = [perplexity, openaiResearch, xaiSearch] as const;
