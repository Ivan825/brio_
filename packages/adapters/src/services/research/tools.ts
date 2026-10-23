// Search and page-fetch services as tools (ADAPTER_SPEC §2.9, docs/vendors/research-browser.md §4–9): the workspace's
// search connector backs every agent's web_search, its fetch connector backs fetch_url, for model APIs in-process and
// for coding CLIs through the brio-mailbox MCP server, so every agent searches the same way and results are comparable.
// Each call is metered as it happens. They are tools, not agents: an agent cannot be built on them.
import { AdapterError } from "../../errors";
import type {
  AgentAdapter,
  ConnectorConfig,
  FetchedPage,
  FetchLike,
  FetchProvider,
  SearchProvider,
  SearchResult,
  SecretHandle,
} from "../../types";
import { ServiceClient } from "../client";

/** What one call cost: dollars the vendor reported, or units in the service's billing unit. */
export interface CallUsage {
  usd?: number;
  units?: number;
}

export interface SearchVendor {
  kind: "search";
  key: string;
  search(
    api: ServiceClient,
    query: string,
    limit: number,
  ): Promise<{ results: SearchResult[]; usage: CallUsage }>;
}

export interface FetchVendor {
  kind: "fetch";
  key: string;
  fetch(api: ServiceClient, url: string): Promise<{ page: FetchedPage; usage: CallUsage }>;
}

export type ResearchVendor = SearchVendor | FetchVendor;

const snippet = (s: string | undefined | null, max = 400) =>
  (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export const exa: SearchVendor = {
  kind: "search",
  key: "exa",
  async search(api, query, limit) {
    const r = await api.json<{
      results?: Array<{
        title?: string;
        url: string;
        text?: string;
        highlights?: string[];
        summary?: string;
      }>;
      costDollars?: { total?: number };
    }>(
      "POST",
      "/search",
      { query, type: "auto", numResults: limit, contents: { highlights: true } },
      { retries: 1 },
    );
    return {
      results: (r.results ?? []).map((x) => ({
        title: x.title ?? x.url,
        url: x.url,
        snippet: snippet(x.highlights?.join(" … ") || x.summary || x.text),
      })),
      usage: r.costDollars?.total !== undefined ? { usd: r.costDollars.total } : { units: 1 },
    };
  },
};

export const tavily: SearchVendor = {
  kind: "search",
  key: "tavily",
  async search(api, query, limit) {
    const r = await api.json<{
      results?: Array<{ title?: string; url: string; content?: string }>;
      usage?: { credits?: number };
    }>("POST", "/search", { query, search_depth: "basic", max_results: Math.min(20, limit) }, { retries: 1 });
    return {
      results: (r.results ?? []).map((x) => ({
        title: x.title ?? x.url,
        url: x.url,
        snippet: snippet(x.content),
      })),
      usage: { units: r.usage?.credits ?? 1 },
    };
  },
};

export const parallel: SearchVendor = {
  kind: "search",
  key: "parallel",
  async search(api, query, limit) {
    const r = await api.json<{ results?: Array<{ url: string; title?: string; excerpts?: string[] }> }>(
      "POST",
      "/v1/search",
      { objective: query, search_queries: [query], mode: "fast", advanced_settings: { max_results: limit } },
      { retries: 1 },
    );
    return {
      results: (r.results ?? []).map((x) => ({
        title: x.title ?? x.url,
        url: x.url,
        snippet: snippet(x.excerpts?.join(" … ")),
      })),
      usage: { units: 1 },
    };
  },
};

export const brave: SearchVendor = {
  kind: "search",
  key: "brave",
  async search(api, query, limit) {
    const r = await api.json<{
      web?: { results?: Array<{ title?: string; url: string; description?: string }> };
    }>("GET", "/web/search", undefined, {
      query: { q: query, count: Math.min(20, limit) },
      headers: { accept: "application/json" },
      retries: 1,
    });
    return {
      results: (r.web?.results ?? []).map((x) => ({
        title: x.title ?? x.url,
        url: x.url,
        // Brave marks query terms with <strong>.
        snippet: snippet(x.description?.replace(/<\/?strong>/g, "")),
      })),
      usage: { units: 1 },
    };
  },
};

export const firecrawl: FetchVendor = {
  kind: "fetch",
  key: "firecrawl",
  async fetch(api, url) {
    const r = await api.json<{
      success?: boolean;
      error?: string;
      data?: {
        markdown?: string;
        metadata?: { title?: string; statusCode?: number; url?: string; sourceURL?: string };
      };
    }>(
      "POST",
      "/scrape",
      { url, formats: ["markdown"], onlyMainContent: true, timeout: 60_000 },
      { retries: 1, timeoutMs: 90_000 },
    );
    if (r.success === false || !r.data)
      throw new AdapterError("bad_request", r.error ?? "the page could not be read");
    const m = r.data.metadata ?? {};
    return {
      page: {
        url: m.url ?? m.sourceURL ?? url,
        title: m.title ?? "",
        content: r.data.markdown ?? "",
        ...(m.statusCode ? { status: m.statusCode } : {}),
      },
      // Every page costs a credit, a 404 included.
      usage: { units: 1 },
    };
  },
};

export const jina: FetchVendor = {
  kind: "fetch",
  key: "jina",
  async fetch(api, url) {
    const r = await api.json<{
      code?: number;
      data?: {
        title?: string;
        url?: string;
        content?: string;
        httpStatus?: number;
        usage?: { tokens?: number };
      };
      meta?: { usage?: { tokens?: number } };
    }>("GET", `/${url}`, undefined, {
      headers: { accept: "application/json", "x-timeout": "30" },
      retries: 1,
      timeoutMs: 60_000,
    });
    const d = r.data ?? {};
    return {
      page: {
        url: d.url ?? url,
        title: d.title ?? "",
        content: d.content ?? "",
        ...(d.httpStatus ? { status: d.httpStatus } : {}),
      },
      usage: { units: d.usage?.tokens ?? r.meta?.usage?.tokens ?? 0 },
    };
  },
};

export const RESEARCH_TOOLS: Readonly<Record<string, ResearchVendor>> = Object.fromEntries(
  [exa, tavily, parallel, brave, firecrawl, jina].map((v) => [v.key, v]),
);

export interface ToolBinding {
  connector: ConnectorConfig;
  /** USD per unit of the service's billing unit (the registry's rate unless the workspace set its own). */
  usdPerUnit: number | null;
}

export interface ToolContext {
  credential: SecretHandle | null;
  fetch: FetchLike;
  /** Records what a call cost (an attempt's cost event). */
  meter(usd: number, note: string): void;
}

const usdOf = (u: CallUsage, perUnit: number | null) =>
  u.usd ?? (u.units !== undefined && perUnit !== null ? u.units * perUnit : 0);

/** A search provider over the workspace's search connector, metering every call. */
export function searchProvider(b: ToolBinding, ctx: ToolContext): SearchProvider {
  const v = RESEARCH_TOOLS[b.connector.service?.adapter ?? ""];
  if (v?.kind !== "search")
    throw new AdapterError("misconfigured", `${b.connector.registryKey} is not a search service`);
  return {
    async search(query, opts) {
      const api = new ServiceClient(b.connector, {
        credential: ctx.credential,
        fetch: ctx.fetch,
        signal: opts.signal,
      });
      const r = await v.search(api, query, Math.max(1, Math.min(20, opts.limit)));
      ctx.meter(usdOf(r.usage, b.usdPerUnit), `${v.key} search`);
      return r.results.slice(0, opts.limit);
    },
  };
}

/** A page fetcher over the workspace's fetch connector, metering every call. */
export function fetchProvider(b: ToolBinding, ctx: ToolContext): FetchProvider {
  const v = RESEARCH_TOOLS[b.connector.service?.adapter ?? ""];
  if (v?.kind !== "fetch")
    throw new AdapterError("misconfigured", `${b.connector.registryKey} is not a fetch service`);
  return {
    async fetch(url, opts) {
      const api = new ServiceClient(b.connector, {
        credential: ctx.credential,
        fetch: ctx.fetch,
        signal: opts.signal,
      });
      const r = await v.fetch(api, url);
      ctx.meter(usdOf(r.usage, b.usdPerUnit), `${v.key} fetch`);
      return r.page;
    },
  };
}

/**
 * The connector side of a tool service: its key check works like any connector's; running it as an agent fails
 * closed (the API does not let agents be built on it).
 */
export function toolAdapter(v: { key: string; kind: string }): AgentAdapter {
  return {
    key: v.key,
    route: "api",
    capabilities: () => ({
      taskTypes: [],
      editsFiles: false,
      runsCode: false,
      browses: false,
      producesMedia: [],
      streaming: false,
      supportsMcpTools: false,
      supportsResume: false,
      runnerModes: ["cloud"],
    }),
    healthCheck: (config, ctx) => new ServiceClient(config, ctx).check(),
    estimate: async () => ({ usd: 0, minutes: 0 }),
    async run() {
      return {
        status: "failed",
        summary: "",
        output: "",
        artifacts: [],
        usage: { usd: 0, tokensIn: 0, tokensOut: 0, seconds: 0 },
        tokens: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
        error: `${v.key} is a ${v.kind} tool agents use, not an agent`,
      };
    },
  };
}

export const RESEARCH_TOOL_ADAPTERS: readonly AgentAdapter[] = Object.values(RESEARCH_TOOLS).map(toolAdapter);
