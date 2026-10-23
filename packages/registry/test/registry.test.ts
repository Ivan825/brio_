import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import data from "../../../registry/connectors.json" with { type: "json" };
import { loadRegistry, parsePlannedAdapter, RegistryError, registry } from "../src/index";

const M1_PRESETS = [
  "openai",
  "anthropic",
  "gemini",
  "xai",
  "meta",
  "mistral",
  "deepseek",
  "kimi",
  "glm",
  "qwen",
  "sarvam",
  "openrouter",
  "litellm",
  "ollama",
  "vllm",
  "groq",
  "together",
  "fireworks",
];

describe("registry/connectors.json", () => {
  const r = registry();

  it("parses and passes the integrity checks", () => {
    expect(r.connectors.length).toBe(98);
    expect(r.categories.map((c) => c.id)).toHaveLength(13);
  });

  it("stays in sync with docs/CONNECTORS.md: one table row per connector", () => {
    const doc = readFileSync(resolve(import.meta.dirname, "../../../docs/CONNECTORS.md"), "utf8");
    const rows = doc.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Connector"));
    expect(rows).toHaveLength(r.connectors.length);
    for (const c of r.connectors) expect(doc, c.name).toContain(`| ${c.name} |`);
  });

  it("has every M1 preset from BUILD_PLAN, each verified against vendor docs", () => {
    for (const key of M1_PRESETS) {
      const p = r.preset(key);
      expect(p, key).toBeDefined();
      expect(p?.verifiedOn, key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p?.docsUrl, key).toMatch(/^https:\/\//);
    }
  });

  it("only gives local presets plain-http defaults, and marks them free", () => {
    for (const [key, p] of Object.entries(r.presets)) {
      if (p.baseUrl?.startsWith("http://")) {
        expect(p.local, key).toBe(true);
        expect(p.pricing.free, key).toBe(true);
      }
    }
  });

  it("marks Meta's Model API as region-limited for the UI", () => {
    expect(r.preset("meta")?.regionLimited).toBeTruthy();
    expect(r.connector("meta-model-api-muse-spark")?.regionLimited).toBeTruthy();
  });

  it("looks up capable connectors by task type, best tier first", () => {
    const coders = r.connectorsFor("code.feature");
    expect(coders.length).toBeGreaterThan(5);
    expect(coders[0]?.tier).toBe("P0");
    expect(
      r
        .connectorsFor("media.voice")
        .every((c) => c.category === "media" || c.taskTypes?.includes("media.voice")),
    ).toBe(true);
    expect(r.taskTypesOf("sarvam-ai-api")).toContain("write.translation_indic");
    // Unsupported connectors can never be asked to do anything.
    for (const c of r.connectors.filter((x) => !x.supported)) expect(r.taskTypesOf(c.id)).toEqual([]);
  });

  it("limits lookups to implemented families when asked", () => {
    const implemented = new Set(["openai-compatible", "anthropic", "gemini"]);
    const ids = r.connectorsFor("write.doc", { implementedFamilies: implemented }).map((c) => c.id);
    expect(ids).toContain("openai-api");
    expect(ids).toContain("claude-api");
    expect(ids).not.toContain("cohere-api");
  });

  it("reports coverage gaps for planned adapters that do not exist", () => {
    expect(r.coverageGaps(new Set(["anthropic"]), "M1").map((g) => g.connector)).toContain("openai-api");
    expect(r.coverageGaps(new Set(["openai-compatible", "anthropic", "gemini"]), "M1")).toEqual([]);
  });

  it("parses planned adapter strings", () => {
    expect(parsePlannedAdapter("openai-compatible:xai")).toEqual({
      family: "openai-compatible",
      preset: "xai",
    });
    expect(parsePlannedAdapter("anthropic")).toEqual({ family: "anthropic", preset: "anthropic" });
  });
});

describe("validation", () => {
  const clone = () => JSON.parse(JSON.stringify(data)) as typeof data & Record<string, unknown>;

  it("rejects an unknown category", () => {
    const bad = clone();
    (bad.connectors[0] as { category: string }).category = "nope";
    expect(() => loadRegistry(bad)).toThrow(RegistryError);
  });

  it("rejects a preset pointing at an unknown connector", () => {
    const bad = clone();
    (bad.presets as Record<string, { connector: string }>).openai!.connector = "nope";
    expect(() => loadRegistry(bad)).toThrow(/unknown connector/);
  });

  it("rejects a task type that is not in the taxonomy", () => {
    const bad = clone();
    (bad.categories[0] as { taskTypes: string[] }).taskTypes = ["code.nonsense"];
    expect(() => loadRegistry(bad)).toThrow(RegistryError);
  });

  it("rejects a supported connector with route none", () => {
    const bad = clone();
    const c = bad.connectors.find((x) => x.routes.includes("none" as never))!;
    (c as { supported: boolean }).supported = true;
    expect(() => loadRegistry(bad)).toThrow(/route "none"/);
  });

  it("rejects a preset with no way to check a key", () => {
    const bad = clone();
    const p = (bad.presets as Record<string, { models: { path: string | null }; health?: unknown }>).glm!;
    p.health = { kind: "models" };
    expect(() => loadRegistry(bad)).toThrow(RegistryError);
  });
});
