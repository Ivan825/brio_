// Live tests against real vendors with your own keys (ADAPTER_SPEC §4). Never in PR CI. Run one vendor with e.g.
//   LIVE_OPENAI=1 OPENAI_API_KEY=… LIVE_OPENAI_MODEL=<id from its model list> pnpm --filter @brio/adapters test:live
// Each enabled vendor: health check, live model list, a one-call hello run, and cost checked against usage.
import { costOf, relativeError } from "@brio/core";
import { registry } from "@brio/registry";
import { describe, expect, it } from "vitest";
import { ADAPTERS } from "../src/index";
import { NO_SANDBOX } from "../src/tools";
import type { AdapterEvent, ConnectorConfig } from "../src/types";
import { helloInput } from "./contract";

const LIVE: Array<{ preset: string; env: string; keyVar: string | null; baseUrlVar?: string }> = [
  { preset: "openai", env: "OPENAI", keyVar: "OPENAI_API_KEY" },
  { preset: "anthropic", env: "ANTHROPIC", keyVar: "ANTHROPIC_API_KEY" },
  { preset: "gemini", env: "GEMINI", keyVar: "GEMINI_API_KEY" },
  { preset: "xai", env: "XAI", keyVar: "XAI_API_KEY" },
  { preset: "meta", env: "META", keyVar: "MODEL_API_KEY" },
  { preset: "mistral", env: "MISTRAL", keyVar: "MISTRAL_API_KEY" },
  { preset: "deepseek", env: "DEEPSEEK", keyVar: "DEEPSEEK_API_KEY" },
  { preset: "kimi", env: "KIMI", keyVar: "MOONSHOT_API_KEY" },
  { preset: "glm", env: "GLM", keyVar: "ZAI_API_KEY" },
  { preset: "qwen", env: "QWEN", keyVar: "DASHSCOPE_API_KEY", baseUrlVar: "QWEN_BASE_URL" },
  { preset: "sarvam", env: "SARVAM", keyVar: "SARVAM_API_KEY" },
  { preset: "openrouter", env: "OPENROUTER", keyVar: "OPENROUTER_API_KEY" },
  { preset: "litellm", env: "LITELLM", keyVar: "LITELLM_API_KEY", baseUrlVar: "LITELLM_BASE_URL" },
  { preset: "ollama", env: "OLLAMA", keyVar: null, baseUrlVar: "OLLAMA_BASE_URL" },
  { preset: "vllm", env: "VLLM", keyVar: null, baseUrlVar: "VLLM_BASE_URL" },
  { preset: "groq", env: "GROQ", keyVar: "GROQ_API_KEY" },
  { preset: "together", env: "TOGETHER", keyVar: "TOGETHER_API_KEY" },
  { preset: "fireworks", env: "FIREWORKS", keyVar: "FIREWORKS_API_KEY" },
];

const logger = { debug() {}, info() {}, warn() {}, error() {} };

for (const v of LIVE) {
  const enabled = process.env[`LIVE_${v.env}`] === "1";
  describe.skipIf(!enabled)(`live: ${v.preset}`, () => {
    const preset = registry().preset(v.preset)!;
    const key = v.keyVar ? process.env[v.keyVar] : undefined;
    const credential = key ? { reveal: () => key } : null;
    const baseUrl = (v.baseUrlVar && process.env[v.baseUrlVar]) || preset.baseUrl!;
    const connector: ConnectorConfig = {
      registryKey: preset.connector,
      presetKey: v.preset,
      preset,
      baseUrl,
    };
    const adapter = ADAPTERS[preset.family]!;
    const ctx = { credential, logger, fetch: globalThis.fetch };

    it("passes the health check and lists models live", async () => {
      const health = await adapter.healthCheck(connector, ctx);
      expect(health.ok, JSON.stringify(health)).toBe(true);
      const models = (await adapter.listModels?.(connector, ctx)) ?? [];
      expect(models.length).toBeGreaterThan(0);
    }, 60_000);

    it("runs the hello task and meters it", async () => {
      const model = process.env[`LIVE_${v.env}_MODEL`];
      if (!model) throw new Error(`set LIVE_${v.env}_MODEL to a model id from the live list`);
      const priceIn = Number(process.env[`LIVE_${v.env}_PRICE_IN`] ?? Number.NaN);
      const priceOut = Number(process.env[`LIVE_${v.env}_PRICE_OUT`] ?? Number.NaN);
      const price =
        Number.isFinite(priceIn) && Number.isFinite(priceOut)
          ? { inputPerM: priceIn, outputPerM: priceOut, cachedInputPerM: null, cacheWritePerM: null }
          : null;
      const events: AdapterEvent[] = [];
      const result = await adapter.run(
        helloInput({ limits: { maxCostUsd: 0.05, maxMinutes: 2, maxOutputTokens: 256 } }),
        {
          agentId: "live",
          name: "live",
          model,
          rolePrompt: "Answer in one short paragraph.",
          connector,
          price,
        },
        { ...ctx, emit: (e) => events.push(e), signal: AbortSignal.timeout(120_000), sandbox: NO_SANDBOX },
      );
      expect(result.status, result.error).toBe("completed");
      expect(result.output.length).toBeGreaterThan(0);
      expect(result.tokens.outputTokens).toBeGreaterThan(0);
      if (price) expect(relativeError(result.usage.usd, costOf(result.tokens, price))).toBeLessThan(0.02);
      expect(JSON.stringify({ events, result })).not.toContain(key ?? "\u0000never");
    }, 180_000);
  });
}
