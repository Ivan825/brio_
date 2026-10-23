import { describe, expect, it } from "vitest";
import { parseFx, pricesFromModels } from "../src/pricing";

describe("pricing helpers", () => {
  it("parses FX rates and ignores junk", () => {
    expect(parseFx("INR=0.0114, CNY=0.14,bad,usd=1,EUR=-1,XYZ=abc")).toEqual({ INR: 0.0114, CNY: 0.14 });
    expect(parseFx(undefined)).toEqual({});
  });

  it("keeps only priced models from a model list", () => {
    const price = { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null };
    expect(
      pricesFromModels("openrouter", [{ id: "a", price }, { id: "b" }], "openrouter", "https://x.test"),
    ).toEqual([
      { presetKey: "openrouter", model: "a", price, source: "openrouter", sourceUrl: "https://x.test" },
    ]);
  });
});
