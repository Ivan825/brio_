import { describe, expect, it } from "vitest";
import {
  anthropicUsage,
  chatUsage,
  geminiUsage,
  openRouterPrice,
  parseChatResponse,
  parseDashscopeModels,
  parseOpenRouterModels,
  parseTogetherModels,
  parseXaiModels,
  requestJson,
  responsesUsage,
  vendorCost,
} from "../src/index";
import { FakeVendor } from "./fake-vendor";

describe("usage normalisation", () => {
  it("chat: cached tokens come out of prompt tokens; DeepSeek cache hits are read too", () => {
    expect(
      chatUsage({ prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } }),
    ).toEqual({
      inputTokens: 60,
      cachedInputTokens: 40,
      cacheWriteTokens: 0,
      outputTokens: 10,
      reasoningTokens: 0,
    });
    expect(
      chatUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 70 }).cachedInputTokens,
    ).toBe(70);
    expect(chatUsage(undefined).inputTokens).toBe(0);
  });

  it("responses, anthropic and gemini map to the same buckets", () => {
    expect(
      responsesUsage({ input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 3 }),
    ).toMatchObject({
      inputTokens: 6,
      cachedInputTokens: 4,
      outputTokens: 3,
    });
    expect(
      anthropicUsage({
        input_tokens: 5,
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: 9,
        output_tokens: 2,
      }),
    ).toEqual({
      inputTokens: 5,
      cachedInputTokens: 7,
      cacheWriteTokens: 9,
      outputTokens: 2,
      reasoningTokens: 0,
    });
    expect(
      geminiUsage({
        promptTokenCount: 10,
        cachedContentTokenCount: 4,
        candidatesTokenCount: 3,
        thoughtsTokenCount: 2,
      }),
    ).toEqual({
      inputTokens: 6,
      cachedInputTokens: 4,
      cacheWriteTokens: 0,
      outputTokens: 5,
      reasoningTokens: 2,
    });
  });

  it("never produces negative buckets from inconsistent vendor numbers", () => {
    const u = chatUsage({
      prompt_tokens: 10,
      completion_tokens: 1,
      prompt_tokens_details: { cached_tokens: 50 },
    });
    expect(u.inputTokens).toBe(0);
    expect(u.cachedInputTokens).toBe(10);
  });
});

describe("parsers", () => {
  it("reads a vendor-reported cost (OpenRouter usage accounting)", () => {
    const turn = parseChatResponse({
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.0042 },
    });
    expect(turn.vendorCostUsd).toBe(0.0042);
  });

  it("keeps malformed tool arguments for the model to see instead of crashing", () => {
    const turn = parseChatResponse({
      choices: [
        {
          message: { tool_calls: [{ id: "c1", function: { name: "x", arguments: "{oops" } }] },
          finish_reason: "tool_calls",
        },
      ],
    });
    expect(turn.toolCalls[0]?.args).toEqual({ _raw: "{oops" });
  });

  it("converts OpenRouter per-token prices to per-million and skips variable prices", () => {
    expect(openRouterPrice({ prompt: "0.000003", completion: "0.000015" })).toEqual({
      inputPerM: 3,
      outputPerM: 15,
      cachedInputPerM: null,
      cacheWritePerM: null,
    });
    expect(openRouterPrice({ prompt: "-1", completion: "-1" })).toBeUndefined();
    const models = parseOpenRouterModels({
      data: [{ id: "a/b", pricing: { prompt: "0", completion: "0" } }, { nope: 1 }],
    });
    expect(models).toEqual([
      { id: "a/b", price: { inputPerM: 0, outputPerM: 0, cachedInputPerM: null, cacheWritePerM: null } },
    ]);
  });
});

describe("requestJson", () => {
  it("retries 5xx with backoff and then succeeds", async () => {
    const v = new FakeVendor({
      generations: [
        { status: 503, body: { error: "busy" }, headers: { "retry-after": "0" } },
        { body: { ok: true } },
      ],
    });
    const res = await requestJson({ fetch: v.fetch, url: "https://x.test/", body: {} });
    expect(res.data).toEqual({ ok: true });
    expect(v.requests).toHaveLength(2);
  });

  it("does not retry client errors and reports invalid JSON", async () => {
    const v = new FakeVendor({ generations: [{ status: 422, body: { message: "no" } }] });
    await expect(requestJson({ fetch: v.fetch, url: "https://x.test/", body: {} })).rejects.toMatchObject({
      code: "bad_request",
      status: 422,
    });
    const bad = async () => new Response("not json", { status: 200 });
    await expect(requestJson({ fetch: bad, url: "https://x.test/" })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});

describe("vendor model lists with prices", () => {
  it("xAI: cents per 100M tokens become dollars per million, with the long-context tier", () => {
    const [m] = parseXaiModels({
      data: [
        {
          id: "grok-x",
          context_length: 1_000_000,
          prompt_text_token_price: 20_000,
          cached_prompt_text_token_price: 5_000,
          completion_text_token_price: 60_000,
          prompt_text_token_price_long_context: 40_000,
          completion_text_token_price_long_context: 120_000,
          long_context_threshold: 200_000,
        },
      ],
    });
    expect(m?.price).toEqual({
      inputPerM: 2,
      outputPerM: 6,
      cachedInputPerM: 0.5,
      cacheWritePerM: null,
      longContext: { thresholdTokens: 200_000, inputPerM: 4, outputPerM: 12, cachedInputPerM: null },
    });
  });

  it("Qwen (DashScope): first price tier, context window", () => {
    const { models, total } = parseDashscopeModels({
      output: {
        total: 1,
        models: [
          {
            model: "qwen-x",
            name: "Qwen X",
            model_info: { context_window: 262144 },
            prices: [
              {
                range_name: "0-256K",
                prices: [
                  { type: "input_token", price: "0.4" },
                  { type: "output_token", price: "1.6" },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(total).toBe(1);
    expect(models[0]).toMatchObject({
      id: "qwen-x",
      contextTokens: 262144,
      price: { inputPerM: 0.4, outputPerM: 1.6 },
    });
  });

  it("Together: bare arrays and {data}, chat models only", () => {
    const bare = parseTogetherModels([
      { id: "a/chat", type: "chat", context_length: 8192, pricing: { input: 0.3, output: 1.2 } },
      { id: "a/embed", type: "embedding" },
    ]);
    expect(bare).toEqual([
      {
        id: "a/chat",
        contextTokens: 8192,
        price: { inputPerM: 0.3, outputPerM: 1.2, cachedInputPerM: null, cacheWritePerM: null },
      },
    ]);
    expect(parseTogetherModels({ data: [{ id: "b" }] })).toEqual([{ id: "b" }]);
  });

  it("reads vendor-reported cost in every documented form", () => {
    expect(vendorCost({ cost: 0.01 })).toBe(0.01);
    expect(vendorCost({ cost_in_usd_ticks: 1e8 })).toBe(0.01);
    expect(vendorCost({ cost_in_nano_usd: 1e7 })).toBe(0.01);
    expect(vendorCost({})).toBeUndefined();
  });
});
