// Security review H1: the price table is shared by every workspace, so one workspace must not be able to set it. A
// model list fetched from an address someone typed in (Qwen's base URL is editable) names that connector's models and
// sets no prices; the vendor's own address does. Viewers cannot trigger a live listing. Needs Postgres.
import { schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";

const KEY = ["sk", "pricetest0123456789abcdef"].join("-");
const OFFICIAL = "https://dashscope-intl.aliyuncs.com";
const ATTACKER = "https://prices.attacker.example";

const list = (inputPrice: string, outputPrice: string) => ({
  output: {
    total: 1,
    models: [
      {
        model: "qwen-max",
        name: "Qwen Max",
        prices: [
          {
            prices: [
              { type: "input_token", price: inputPrice },
              { type: "output_token", price: outputPrice },
            ],
          },
        ],
      },
    ],
  },
});

describe.skipIf(!hasTestDatabase)("security review H1: one workspace cannot set everyone's prices", () => {
  let h: Harness;
  let c: Client;

  beforeAll(async () => {
    h = await startHarness({
      runner: false,
      fetch: async (input) => {
        const url = String(input);
        const json = (v: unknown) =>
          new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
        if (url.startsWith(`${ATTACKER}/api/v1/models`)) return json(list("0", "0"));
        if (url.startsWith(`${OFFICIAL}/api/v1/models`)) return json(list("1.6", "6.4"));
        if (url.includes("/models")) return json({ object: "list", data: [{ id: "qwen-max" }] });
        return new Response("{}", { status: 404 });
      },
    });
    c = new Client(h);
    await c.signIn("prices@example.com");
    await c.request("POST", "/v1/workspaces", { name: "Prices" });
  });
  afterAll(async () => {
    await h?.close();
  });

  const qwenMax = () =>
    h.db.db
      .select()
      .from(schema.modelPrices)
      .where(and(eq(schema.modelPrices.presetKey, "qwen"), eq(schema.modelPrices.model, "qwen-max")));

  it("takes no prices from a model list at an address someone typed in", async () => {
    const before = await qwenMax();
    const connector = await c.request("POST", "/v1/connectors", {
      registryKey: "qwen-model-studio",
      preset: "qwen",
      apiKey: KEY,
      baseUrl: `${ATTACKER}/compatible-mode/v1`,
    });
    expect(connector.statusCode, connector.body).toBe(201);
    const res = await c.request("GET", `/v1/connectors/${connector.json().connector.id}/models?refresh=true`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().models.map((m: { id: string }) => m.id)).toContain("qwen-max");
    const after = await qwenMax();
    expect(after).toEqual(before);
    expect(after.some((p) => p.sourceUrl.startsWith(ATTACKER))).toBe(false);
  });

  it("takes them from the vendor's own address", async () => {
    const connector = await c.request("POST", "/v1/connectors", {
      registryKey: "qwen-model-studio",
      preset: "qwen",
      apiKey: KEY,
    });
    expect(connector.statusCode, connector.body).toBe(201);
    const res = await c.request("GET", `/v1/connectors/${connector.json().connector.id}/models?refresh=true`);
    expect(res.statusCode, res.body).toBe(200);
    const [price] = await qwenMax();
    expect(price).toMatchObject({ source: "models_endpoint", inputPerM: 1.6, outputPerM: 6.4 });
    expect(price?.sourceUrl.startsWith(OFFICIAL)).toBe(true);
  });
});
