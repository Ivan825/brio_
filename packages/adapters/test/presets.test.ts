// Every preset in the registry is wired to an adapter (the CI check from ADAPTER_SPEC §1) and builds the requests its
// vendor documents: the right URL, auth header and API shape.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { registry } from "@brio/registry";
import { describe, expect, it } from "vitest";
import { ADAPTERS, ADAPTERS_THROUGH_MILESTONE, adapterFor, IMPLEMENTED_FAMILIES } from "../src/index";
import type { ConnectorConfig } from "../src/types";
import { FAKE_KEY, harness, helloInput } from "./contract";
import { FakeVendor } from "./fake-vendor";

const fixture = (path: string): unknown =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures", path), "utf8"));

const r = registry();

describe("registry coverage", () => {
  it(`every P0/P1 connector planned through ${ADAPTERS_THROUGH_MILESTONE} has an adapter and a preset`, () => {
    expect(r.coverageGaps(IMPLEMENTED_FAMILIES, ADAPTERS_THROUGH_MILESTONE)).toEqual([]);
  });

  it("every preset's family is implemented", () => {
    for (const [key, p] of Object.entries(r.presets)) expect(adapterFor(p.family), key).toBeDefined();
  });

  it("no adapter exists for an unsupported connector (ADAPTER_SPEC §3)", () => {
    for (const c of r.connectors.filter((x) => !x.supported)) expect(r.presetsFor(c.id), c.id).toEqual([]);
  });
});

const helloFor = (family: string, style: string) =>
  family === "openai-compatible" ? fixture(`${style}/hello.json`) : fixture(`${family}/hello.json`);

describe.each(Object.entries(r.presets))("preset %s", (key, preset) => {
  const baseUrl = preset.baseUrl ?? "http://localhost:4000/v1";
  const styles = preset.family === "openai-compatible" ? preset.apiStyles : ["native"];

  it.each(styles)("sends a correct %s request", async (style) => {
    const connector: ConnectorConfig = {
      registryKey: preset.connector,
      presetKey: key,
      preset,
      baseUrl,
      ...(style === "chat" || style === "responses" ? { apiStyle: style } : {}),
    };
    const vendor = new FakeVendor({ generations: [{ body: helloFor(preset.family, style) }] });
    const h = harness(
      {
        name: key,
        adapter: ADAPTERS[preset.family]!,
        connector,
        model: "some-model",
        price: { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null },
        fixtures: { models: [], hello: null, toolCall: null, afterTool: null },
        helloUsage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
        helloText: "",
        modelCount: 0,
        generationPath: /./,
        authHeader: () => null,
      },
      vendor,
    );
    const result = await ADAPTERS[preset.family]!.run(helloInput(), h.agent, h.ctx);
    expect(result.status, result.error).toBe("completed");
    const req = vendor.generationRequests[0]!;
    const path =
      preset.family === "anthropic"
        ? "/messages"
        : preset.family === "gemini"
          ? "/models/some-model:generateContent"
          : style === "responses"
            ? "/responses"
            : "/chat/completions";
    expect(req.url).toBe(`${baseUrl.replace(/\/+$/, "")}${path}`);
    const expected: Record<string, [string, string]> = {
      bearer: ["authorization", `Bearer ${FAKE_KEY}`],
      "optional-bearer": ["authorization", `Bearer ${FAKE_KEY}`],
      "x-api-key": ["x-api-key", FAKE_KEY],
      "x-goog-api-key": ["x-goog-api-key", FAKE_KEY],
    };
    const auth = expected[preset.auth];
    if (auth) expect(req.headers[auth[0]]).toBe(auth[1]);
    if (preset.family === "anthropic") expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    if (style === "chat") expect(req.body).toHaveProperty(preset.maxTokensParam, 1024);
  });

  it("checks a key without generating anything", async () => {
    const connector: ConnectorConfig = { registryKey: preset.connector, presetKey: key, preset, baseUrl };
    const listBody =
      preset.models.shape === "anthropic"
        ? { data: [], has_more: false }
        : preset.models.shape === "gemini"
          ? { models: [] }
          : preset.models.shape === "dashscope"
            ? { output: { models: [], total: 0 } }
            : { data: [] };
    const seen: string[] = [];
    const fetch = async (url: string | URL, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (init?.method === "POST")
        return new Response(JSON.stringify({ error: { message: "missing model" } }), { status: 400 });
      return new Response(JSON.stringify(listBody), { status: 200 });
    };
    const h = harness(
      {
        name: key,
        adapter: ADAPTERS[preset.family]!,
        connector,
        model: "m",
        price: null,
        fixtures: { models: [], hello: null, toolCall: null, afterTool: null },
        helloUsage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
        helloText: "",
        modelCount: 0,
        generationPath: /./,
        authHeader: () => null,
      },
      new FakeVendor(),
      { fetch },
    );
    const status = await ADAPTERS[preset.family]!.healthCheck(connector, h.ctx);
    expect(status.ok, JSON.stringify(status)).toBe(true);
    expect(seen).toHaveLength(1);
    if (preset.health.kind === "probe") expect(seen[0]).toMatch(/^POST /);
    else expect(seen[0]).toMatch(/^GET /);
  });
});
