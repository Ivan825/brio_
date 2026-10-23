import { describe, expect, it } from "vitest";
import {
  addUsage,
  costOf,
  estimateCost,
  FREE,
  isPeak,
  type ModelPrice,
  openRouterCandidates,
  type PriceRow,
  relativeError,
  resolvePrice,
  shouldReplace,
  type TokenUsage,
  ZERO_USAGE,
} from "../src/index";

const price: ModelPrice = { inputPerM: 3, outputPerM: 15, cachedInputPerM: 0.3, cacheWritePerM: 3.75 };
const usage = (u: Partial<TokenUsage>): TokenUsage => ({ ...ZERO_USAGE, ...u });

describe("costOf", () => {
  it("bills each usage bucket at its own rate", () => {
    const u = usage({
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(costOf(u, price)).toBe(3 + 0.3 + 3.75 + 15);
  });

  it("charges cached and cache-write tokens the input rate when the vendor has no discount", () => {
    const flat: ModelPrice = { inputPerM: 2, outputPerM: 8, cachedInputPerM: null, cacheWritePerM: null };
    expect(costOf(usage({ cachedInputTokens: 500_000, cacheWriteTokens: 500_000 }), flat)).toBe(2);
  });

  it("rounds to the micro-dollar", () => {
    expect(costOf(usage({ inputTokens: 1, outputTokens: 1 }), price)).toBe(0.000018);
    expect(costOf(usage({ inputTokens: 7 }), { ...price, inputPerM: 0.1 })).toBe(0.000001);
  });

  it("switches the whole call to the long-context tier above its threshold", () => {
    const tiered: ModelPrice = {
      ...price,
      longContext: { thresholdTokens: 200_000, inputPerM: 6, outputPerM: 22.5, cachedInputPerM: 0.6 },
    };
    expect(costOf(usage({ inputTokens: 200_000, outputTokens: 1000 }), tiered)).toBe(0.6 + 0.015);
    expect(costOf(usage({ inputTokens: 200_001, outputTokens: 1000 }), tiered)).toBeCloseTo(
      1.200006 + 0.0225,
      6,
    );
  });

  it("applies off-peak discounts by UTC time (DeepSeek-style), never on weekends' peak rule", () => {
    const tod: ModelPrice = {
      inputPerM: 1,
      outputPerM: 4,
      cachedInputPerM: null,
      cacheWritePerM: null,
      offPeak: {
        multiplier: 0.5,
        peakUtcHours: [
          [1, 4],
          [6, 10],
        ],
        weekdaysOnly: true,
      },
    };
    const u = usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(costOf(u, tod, new Date("2026-10-21T02:30:00Z"))).toBe(5); // Wednesday, in a peak window
    expect(costOf(u, tod, new Date("2026-10-21T05:00:00Z"))).toBe(2.5); // between windows
    expect(costOf(u, tod, new Date("2026-10-24T02:30:00Z"))).toBe(2.5); // Saturday
    expect(isPeak(price, new Date())).toBe(true);
  });

  it("is free for local models", () => {
    expect(costOf(usage({ inputTokens: 10_000, outputTokens: 10_000 }), FREE)).toBe(0);
  });

  it("refuses nonsense instead of recording a wrong number", () => {
    expect(() => costOf(usage({ inputTokens: -1 }), price)).toThrow(RangeError);
    expect(() => costOf(usage({ outputTokens: Number.NaN }), price)).toThrow(RangeError);
    expect(() => costOf(ZERO_USAGE, { ...price, outputPerM: -1 })).toThrow(RangeError);
  });

  it("matches a provider-reported cost within 2% (OpenRouter usage accounting fixture)", () => {
    // Reported by the vendor for 1,234 prompt (200 cached) and 567 completion tokens at $3/$15/$0.30.
    const reported = 0.003102 + 0.00006 + 0.008505;
    const ours = costOf(usage({ inputTokens: 1034, cachedInputTokens: 200, outputTokens: 567 }), price);
    expect(relativeError(ours, reported)).toBeLessThan(0.02);
  });
});

describe("usage helpers", () => {
  it("adds usage bucket by bucket", () => {
    const a = usage({
      inputTokens: 1,
      cachedInputTokens: 2,
      cacheWriteTokens: 3,
      outputTokens: 4,
      reasoningTokens: 1,
    });
    expect(addUsage(a, a)).toEqual({
      inputTokens: 2,
      cachedInputTokens: 4,
      cacheWriteTokens: 6,
      outputTokens: 8,
      reasoningTokens: 2,
    });
  });

  it("relativeError handles zero", () => {
    expect(relativeError(0, 0)).toBe(0);
    expect(relativeError(1, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(relativeError(1.01, 1)).toBeCloseTo(0.01);
  });
});

describe("estimateCost", () => {
  it("assumes the whole output budget and no cache", () => {
    expect(estimateCost({ promptChars: 4_000_000, maxOutputTokens: 1_000_000 }, price)).toBe(3 + 15);
  });

  it("grows with tool-loop turns because each turn resends the conversation", () => {
    const one = estimateCost({ promptChars: 4000, maxOutputTokens: 1000, turns: 1 }, price);
    const three = estimateCost({ promptChars: 4000, maxOutputTokens: 1000, turns: 3 }, price);
    expect(three).toBeGreaterThan(3 * one);
  });
});

describe("price lookup", () => {
  const row = (
    presetKey: string,
    model: string,
    inputPerM: number,
    source: PriceRow["source"] = "vendor_docs",
  ): PriceRow => ({
    presetKey,
    model,
    price: { inputPerM, outputPerM: inputPerM * 5, cachedInputPerM: null, cacheWritePerM: null },
    source,
    sourceUrl: "https://example.com",
    fetchedAt: new Date(0),
  });
  const base = {
    presetKey: "anthropic",
    model: "claude-opus-4-1-20250805",
    override: null,
    openrouterPrefix: "anthropic",
    free: false,
  };

  it("maps vendor ids to OpenRouter ids", () => {
    expect(openRouterCandidates("anthropic", "claude-opus-4-1-20250805")).toEqual([
      "anthropic/claude-opus-4-1-20250805",
      "anthropic/claude-opus-4-1",
      "anthropic/claude-opus-4.1",
    ]);
    expect(openRouterCandidates("google", "models/gemini-2.5-pro")).toEqual(["google/gemini-2.5-pro"]);
    expect(openRouterCandidates("openai", "gpt-5-2025-08-07")).toEqual([
      "openai/gpt-5-2025-08-07",
      "openai/gpt-5",
    ]);
  });

  it("prefers the agent override, then the preset's own row, then OpenRouter, then free", () => {
    const rows = [row("openrouter", "anthropic/claude-opus-4.1", 15, "openrouter")];
    const override = { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null };
    expect(resolvePrice({ ...base, override, rows }).kind).toBe("override");
    expect(resolvePrice({ ...base, rows })).toMatchObject({ kind: "table", price: { inputPerM: 15 } });
    expect(resolvePrice({ ...base, rows: [...rows, row("anthropic", base.model, 14)] })).toMatchObject({
      kind: "table",
      price: { inputPerM: 14 },
    });
    expect(resolvePrice({ ...base, rows: [] }).kind).toBe("unknown");
    expect(resolvePrice({ ...base, rows: [], free: true }).kind).toBe("free");
  });

  it("only lets equal or better sources replace a stored price", () => {
    expect(shouldReplace(undefined, "vendor_docs")).toBe(true);
    expect(shouldReplace("openrouter", "vendor_docs")).toBe(false);
    expect(shouldReplace("vendor_docs", "openrouter")).toBe(true);
    expect(shouldReplace("models_endpoint", "openrouter")).toBe(false);
  });
});
