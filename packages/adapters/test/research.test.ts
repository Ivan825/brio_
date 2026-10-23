// Research (ADAPTER_SPEC §2.9) against fakes built from each vendor's documented wire format
// (docs/vendors/research-browser.md): search and fetch tools meter every call and never leak the key; research agents
// answer with a cited report, run in background mode where the vendor has it, and meter what the vendor reports.
import { registry } from "@brio/registry";
import { describe, expect, it } from "vitest";
import { ADAPTERS } from "../src/index";
import {
  answerOf,
  fetchProvider,
  RESEARCH_TOOLS,
  reportOf,
  searchProvider,
} from "../src/services/research/index";
import type {
  AdapterEvent,
  AgentAdapter,
  AgentConfig,
  ConnectorConfig,
  RunContext,
  RunInput,
} from "../src/types";
import { helloInput, secret } from "./contract";
import { FakeService } from "./service-fakes";

const KEY = ["research", "key", "0123456789abcdefghijklmnop"].join("-");
const signal = new AbortController().signal;

const connectorOf = (service: string): ConnectorConfig => {
  const sv = registry().service(service);
  if (!sv) throw new Error(`no service ${service}`);
  return { registryKey: sv.connector, serviceKey: service, service: sv, settings: {}, baseUrl: "" };
};

interface ToolCase {
  service: string;
  authed: (h: Record<string, string>) => boolean;
  install: (f: FakeService) => void;
  /** USD metered for one call at the registry's rate (or as reported). */
  usd: number;
}

const SEARCHES: ToolCase[] = [
  {
    service: "exa",
    authed: (h) => h["x-api-key"] === KEY,
    install: (f) =>
      void f.on("POST", /^\/search$/, () => ({
        results: [{ title: "Brio", url: "https://brio.dev", highlights: ["one goal,", "many agents"] }],
        costDollars: { total: 0.007 },
      })),
    usd: 0.007,
  },
  {
    service: "tavily",
    authed: (h) => h.authorization === `Bearer ${KEY}`,
    install: (f) =>
      void f.on("POST", /^\/search$/, () => ({
        results: [{ title: "Brio", url: "https://brio.dev", content: "one goal,   many agents" }],
        usage: { credits: 1 },
      })),
    usd: 0.008,
  },
  {
    service: "parallel",
    authed: (h) => h["x-api-key"] === KEY,
    install: (f) =>
      void f.on("POST", /^\/v1\/search$/, (r) => {
        expect(r.body).toMatchObject({ search_queries: ["brio orchestrator"], mode: "fast" });
        return {
          search_id: "s1",
          results: [{ url: "https://brio.dev", title: "Brio", excerpts: ["one goal,", "many agents"] }],
        };
      }),
    usd: 0.001,
  },
  {
    service: "brave",
    authed: (h) => h["x-subscription-token"] === KEY,
    install: (f) =>
      void f.on("GET", /^\/res\/v1\/web\/search\?q=brio\+orchestrator&count=3$/, () => ({
        web: {
          results: [
            { title: "Brio", url: "https://brio.dev", description: "one goal, <strong>many</strong> agents" },
          ],
        },
      })),
    usd: 0.005,
  },
];

const FETCHES: ToolCase[] = [
  {
    service: "firecrawl",
    authed: (h) => h.authorization === `Bearer ${KEY}`,
    install: (f) =>
      void f.on("POST", /^\/v2\/scrape$/, () => ({
        success: true,
        data: {
          markdown: "# Brio\nThe conductor.",
          metadata: { title: "Brio", statusCode: 200, url: "https://brio.dev/" },
        },
      })),
    usd: 0.001,
  },
  {
    service: "jina",
    authed: (h) => h.authorization === `Bearer ${KEY}`,
    install: (f) =>
      void f.on("GET", /^\/https:\/\/brio\.dev/, () => ({
        code: 200,
        data: {
          title: "Brio",
          url: "https://brio.dev/",
          content: "# Brio\nThe conductor.",
          httpStatus: 200,
          usage: { tokens: 28 },
        },
      })),
    usd: 0,
  },
];

function tool(c: ToolCase) {
  const fake = new FakeService();
  c.install(fake);
  const metered: Array<[number, string]> = [];
  const sv = registry().service(c.service);
  const binding = { connector: connectorOf(c.service), usdPerUnit: sv?.pricing.usdPerUnit ?? null };
  const ctx = {
    credential: secret(KEY),
    fetch: fake.fetch,
    meter: (usd: number, note: string) => void metered.push([usd, note]),
  };
  return { fake, metered, binding, ctx };
}

describe("research tools", () => {
  it("covers every search and fetch service, and none can be routed to as an agent", () => {
    const tools = Object.entries(registry().services).filter(
      ([, s]) => s.kind === "search" || s.kind === "fetch",
    );
    expect([...SEARCHES, ...FETCHES].map((c) => c.service).sort()).toEqual(tools.map(([k]) => k).sort());
    for (const [k, s] of tools) {
      expect(RESEARCH_TOOLS[s.adapter]?.kind, k).toBe(s.kind);
      expect(s.taskTypes, k).toEqual([]);
    }
  });

  for (const c of SEARCHES)
    it(`${c.service}: searches, meters the call, keeps the key to the vendor`, async () => {
      const t = tool(c);
      const results = await searchProvider(t.binding, t.ctx).search("brio orchestrator", {
        limit: 3,
        signal,
      });
      expect(results).toEqual([
        {
          title: "Brio",
          url: "https://brio.dev",
          snippet: expect.stringMatching(/^one goal, …? ?many agents$/),
        },
      ]);
      expect(t.metered).toHaveLength(1);
      expect(t.metered[0]?.[0]).toBeCloseTo(c.usd, 6);
      for (const r of t.fake.requests) expect(c.authed(r.headers)).toBe(true);
    });

  for (const c of FETCHES)
    it(`${c.service}: reads a page as Markdown and meters it`, async () => {
      const t = tool(c);
      const page = await fetchProvider(t.binding, t.ctx).fetch("https://brio.dev", { signal });
      expect(page).toMatchObject({
        title: "Brio",
        url: "https://brio.dev/",
        content: "# Brio\nThe conductor.",
        status: 200,
      });
      expect(t.metered[0]?.[0]).toBeCloseTo(c.usd, 6);
      for (const r of t.fake.requests) expect(c.authed(r.headers)).toBe(true);
    });

  it("refuses to bind a tool of the wrong kind", () => {
    const t = tool(SEARCHES[0] as ToolCase);
    expect(() => fetchProvider(t.binding, t.ctx)).toThrow(/not a fetch service/);
  });

  it("is a connector whose key can be checked, never an agent", async () => {
    const adapter = ADAPTERS.tavily as AgentAdapter;
    const f = new FakeService().on("GET", /^\/usage$/, (r) =>
      r.headers.authorization === `Bearer ${KEY}` ? { key: {} } : new Response("{}", { status: 401 }),
    );
    const ctx = {
      credential: secret(KEY),
      fetch: f.fetch,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    };
    expect((await adapter.healthCheck(connectorOf("tavily"), ctx)).ok).toBe(true);
    const run = await adapter.run(helloInput(), {} as AgentConfig, {} as RunContext);
    expect(run).toMatchObject({ status: "failed", error: expect.stringMatching(/not an agent/) });
  });
});

const ANSWER = "Brio routes each task to the best agent [1]. It verifies results across vendors [2].";

interface AgentCase {
  service: string;
  model: string;
  authed: (h: Record<string, string>) => boolean;
  install: (f: FakeService) => void;
  request: (f: FakeService) => void;
  usd: number;
  cancelCall?: { method: string; path: RegExp };
}

const AGENTS: AgentCase[] = [
  {
    service: "perplexity",
    model: "auto",
    authed: (h) => h.authorization === `Bearer ${KEY}`,
    install: (f) =>
      void f
        .on("POST", /^\/v1\/agent$/, () => ({ id: "r1", status: "queued" }))
        .on("GET", /^\/v1\/agent\/r1$/, (_r, n) =>
          n === 0
            ? { id: "r1", status: "in_progress" }
            : {
                id: "r1",
                status: "completed",
                output: [
                  {
                    type: "search_results",
                    results: [
                      { id: 2, title: "Verification", url: "https://brio.dev/verify" },
                      { id: 1, title: "Routing", url: "https://brio.dev/route" },
                    ],
                  },
                  {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: ANSWER, annotations: [] }],
                  },
                ],
                usage: {
                  input_tokens: 900,
                  output_tokens: 120,
                  cost: { currency: "USD", total_cost: 0.0123 },
                },
              },
        ),
    request(f) {
      expect(f.calls("POST", /agent$/)[0]?.body).toMatchObject({
        background: true,
        tools: [{ type: "web_search" }, { type: "fetch_url" }],
        effort: "low",
      });
      expect(f.calls("POST", /agent$/)[0]?.body).not.toHaveProperty("model");
    },
    usd: 0.0123,
  },
  {
    service: "openai-research",
    model: "gpt-5.5",
    authed: (h) => h.authorization === `Bearer ${KEY}`,
    install: (f) =>
      void f
        .on("POST", /^\/v1\/responses$/, () => ({ id: "resp_1", status: "queued" }))
        .on("GET", /^\/v1\/responses\/resp_1$/, (_r, n) =>
          n === 0
            ? { id: "resp_1", status: "in_progress" }
            : {
                id: "resp_1",
                status: "completed",
                output: [
                  {
                    type: "web_search_call",
                    status: "completed",
                    action: { type: "search", sources: [{ url: "https://brio.dev/route" }] },
                  },
                  { type: "web_search_call", status: "completed", action: { type: "search" } },
                  {
                    type: "message",
                    content: [
                      {
                        type: "output_text",
                        text: ANSWER,
                        annotations: [
                          { type: "url_citation", url: "https://brio.dev/route", title: "Routing" },
                          { type: "url_citation", url: "https://brio.dev/verify", title: "Verification" },
                        ],
                      },
                    ],
                  },
                ],
                usage: {
                  input_tokens: 1_000_000,
                  output_tokens: 100_000,
                  input_tokens_details: { cached_tokens: 0 },
                },
              },
        )
        .on("POST", /^\/v1\/responses\/resp_1\/cancel$/, () => ({})),
    request(f) {
      expect(f.calls("POST", /responses$/)[0]?.body).toMatchObject({
        model: "gpt-5.5",
        background: true,
        tools: [{ type: "web_search" }],
        include: ["web_search_call.action.sources"],
      });
    },
    // 1M in at $1 + 100k out at $2 per 1M (the test's price), plus two searches at $0.01.
    usd: 1 + 0.2 + 0.02,
    cancelCall: { method: "POST", path: /\/responses\/resp_1\/cancel$/ },
  },
  {
    service: "xai-search",
    model: "grok-4.7",
    authed: (h) => h.authorization === `Bearer ${KEY}`,
    install: (f) =>
      void f.on("POST", /^\/v1\/responses$/, () => ({
        id: "x1",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: ANSWER }] }],
        citations: ["https://brio.dev/route", "https://x.com/brio/status/1"],
        usage: { input_tokens: 0, output_tokens: 0, server_side_tool_usage: { web_search: 2, x_search: 1 } },
      })),
    request(f) {
      expect(f.calls("POST", /responses$/)[0]?.body).toMatchObject({
        model: "grok-4.7",
        tools: [{ type: "web_search" }, { type: "x_search" }],
      });
      expect(f.calls("POST", /responses$/)[0]?.body).not.toHaveProperty("background");
    },
    usd: 3 * 0.005,
  },
];

function agent(c: AgentCase, forever = false) {
  const fake = new FakeService();
  if (forever)
    fake
      .on("POST", /responses$|agent$/, () => ({ id: "resp_1", status: "queued" }))
      .on("GET", /./, () => ({ id: "resp_1", status: "in_progress" }))
      .on("POST", /cancel$/, () => ({}));
  else c.install(fake);
  const sv = registry().service(c.service);
  if (!sv) throw new Error(`no service ${c.service}`);
  const config: AgentConfig = {
    agentId: "a1",
    name: "Researcher",
    model: c.model,
    rolePrompt: "",
    connector: connectorOf(c.service),
    price: { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null },
    unitPrice: null,
    options: { pollMs: 5 },
  };
  const events: AdapterEvent[] = [];
  const controller = new AbortController();
  const ctx = {
    credential: secret(KEY),
    emit: (e: AdapterEvent) => void events.push(e),
    signal: controller.signal,
    sandbox: {} as RunContext["sandbox"],
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    fetch: fake.fetch,
  } satisfies RunContext;
  const input: RunInput = {
    ...helloInput(),
    taskType: "research.web",
    instructions: "What does Brio do? Cite sources.",
    limits: { maxCostUsd: 5, maxMinutes: 5, maxOutputTokens: 1024 },
  };
  return { fake, config, ctx, events, controller, input, adapter: ADAPTERS[sv.adapter] as AgentAdapter };
}

describe("research agents", () => {
  it("covers every research service", () => {
    const research = Object.entries(registry().services).filter(([, s]) => s.kind === "research");
    for (const [k, s] of research) expect(ADAPTERS[s.adapter], k).toBeDefined();
    expect(AGENTS.map((c) => c.service).sort()).toEqual(
      research
        .filter(([, s]) => s.adapter !== "gemini-managed-agents")
        .map(([k]) => k)
        .sort(),
    );
  });

  for (const c of AGENTS)
    describe(c.service, () => {
      it("answers with a cited report and meters it", async () => {
        const s = agent(c);
        const res = await s.adapter.run(s.input, s.config, s.ctx);
        expect(res.status, res.error).toBe("completed");
        c.request(s.fake);
        expect(res.output).toContain(ANSWER);
        expect(res.output).toMatch(/## Sources\n1\. \[[^\]]+\]\(https:\/\/brio\.dev\/(route|verify)\)/);
        expect(res.usage.usd).toBeCloseTo(c.usd, 6);
        for (const r of s.fake.requests) expect(c.authed(r.headers)).toBe(true);
        expect(JSON.stringify(s.events)).not.toContain(KEY);
      });

      const cancelCall = c.cancelCall;
      if (cancelCall)
        it("cancels the background run when the attempt is cancelled", async () => {
          const s = agent(c, true);
          const run = s.adapter.run(s.input, s.config, s.ctx);
          await new Promise((r) => setTimeout(r, 40));
          s.controller.abort();
          expect((await run).status).toBe("cancelled");
          expect(s.fake.calls(cancelCall.method, cancelCall.path)).toHaveLength(1);
        });
    });

  it("numbers Perplexity's sources the way its [n] markers do", () => {
    const { sources } = answerOf({
      output: [
        {
          type: "search_results",
          results: [
            { id: 2, title: "B", url: "https://b.example" },
            { id: 1, title: "A", url: "https://a.example" },
          ],
        },
      ],
    });
    expect(sources.map((x) => x.url)).toEqual(["https://a.example", "https://b.example"]);
  });

  it("leaves an answer without sources as it is", () => {
    expect(
      reportOf({ output: [{ type: "message", content: [{ type: "output_text", text: "No sources." }] }] }),
    ).toBe("No sources.");
  });

  it("reports a failed run with its reason", async () => {
    const c = AGENTS[0] as AgentCase;
    const s = agent({
      ...c,
      install: (f) =>
        void f
          .on("POST", /agent$/, () => ({ id: "r1", status: "queued" }))
          .on("GET", /agent\/r1$/, () => ({
            id: "r1",
            status: "failed",
            error: { message: "org token limit" },
          })),
    });
    const res = await s.adapter.run(s.input, s.config, s.ctx);
    expect(res).toMatchObject({ status: "failed", error: "org token limit" });
  });
});
