import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelPrice } from "@brio/core";
import { Preset } from "@brio/registry";
import { ADAPTERS } from "../src/index";
import type { ConnectorConfig } from "../src/types";
import { defineAdapterContract } from "./contract";

const fixture = (path: string): unknown =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures", path), "utf8"));

const price: ModelPrice = { inputPerM: 3, outputPerM: 15, cachedInputPerM: 0.3, cacheWritePerM: 3.75 };

const basePreset = {
  connector: "openai-api",
  name: "Fixture",
  baseUrlEditable: false,
  tools: true,
  pricing: { openrouterPrefix: null },
  docsUrl: "https://example.com/docs",
  verifiedOn: "2026-10-23",
};

function connector(
  presetKey: string,
  preset: unknown,
  baseUrl: string,
  apiStyle?: "chat" | "responses",
): ConnectorConfig {
  return {
    registryKey: (preset as { connector: string }).connector,
    presetKey,
    preset: Preset.parse(preset),
    baseUrl,
    ...(apiStyle ? { apiStyle } : {}),
  };
}

const helloText = "Hello from the fixture. I restated the goal and proposed a plan.";
const helloUsage = {
  inputTokens: 1000,
  cachedInputTokens: 200,
  cacheWriteTokens: 0,
  outputTokens: 300,
  reasoningTokens: 120,
};

for (const style of ["chat", "responses"] as const) {
  defineAdapterContract({
    name: `openai-compatible (${style})`,
    adapter: ADAPTERS["openai-compatible"]!,
    connector: connector(
      "fixture",
      {
        ...basePreset,
        family: "openai-compatible",
        baseUrl: "https://api.vendor.test/v1",
        auth: "bearer",
        apiStyles: ["responses", "chat"],
        models: { path: "/models", shape: "openai" },
      },
      "https://api.vendor.test/v1",
      style,
    ),
    model: "fixture-large",
    price,
    fixtures: {
      models: [fixture(`${style}/models.json`)],
      hello: fixture(`${style}/hello.json`),
      toolCall: fixture(`${style}/tool-call.json`),
      afterTool: fixture(`${style}/after-tool.json`),
    },
    helloUsage,
    helloText,
    modelCount: 2,
    generationPath: style === "chat" ? /\/v1\/chat\/completions$/ : /\/v1\/responses$/,
    authHeader: (key) => ["authorization", `Bearer ${key}`],
  });
}

defineAdapterContract({
  name: "anthropic",
  adapter: ADAPTERS.anthropic!,
  connector: connector(
    "fixture",
    {
      ...basePreset,
      connector: "claude-api",
      family: "anthropic",
      baseUrl: "https://api.anthropic.test/v1",
      auth: "x-api-key",
      models: { path: "/models", shape: "anthropic" },
    },
    "https://api.anthropic.test/v1",
  ),
  model: "fixture-large",
  price,
  fixtures: {
    models: [fixture("anthropic/models.json"), fixture("anthropic/models-page-2.json")],
    hello: fixture("anthropic/hello.json"),
    toolCall: fixture("anthropic/tool-call.json"),
    afterTool: fixture("anthropic/after-tool.json"),
  },
  helloUsage: { ...helloUsage, reasoningTokens: 0 },
  helloText,
  modelCount: 2,
  generationPath: /\/v1\/messages$/,
  authHeader: (key) => ["x-api-key", key],
});

defineAdapterContract({
  name: "gemini",
  adapter: ADAPTERS.gemini!,
  connector: connector(
    "fixture",
    {
      ...basePreset,
      connector: "gemini-api",
      family: "gemini",
      baseUrl: "https://generativelanguage.test/v1beta",
      auth: "x-goog-api-key",
      models: { path: "/models", shape: "gemini" },
    },
    "https://generativelanguage.test/v1beta",
  ),
  model: "fixture-large",
  price,
  fixtures: {
    models: [fixture("gemini/models.json"), fixture("gemini/models-page-2.json")],
    hello: fixture("gemini/hello.json"),
    toolCall: fixture("gemini/tool-call.json"),
    afterTool: fixture("gemini/after-tool.json"),
  },
  helloUsage,
  helloText,
  modelCount: 2,
  generationPath: /\/v1beta\/models\/fixture-large:generateContent$/,
  authHeader: (key) => ["x-goog-api-key", key],
});
