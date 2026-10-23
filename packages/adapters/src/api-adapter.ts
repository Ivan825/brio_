// What the three model-API families share: health check via the model list, live listing, estimates and the tool loop.
// A family supplies only its driver (one model call in the vendor's format) and its request headers.
import { estimateCost, FREE } from "@brio/core";
import { registry } from "@brio/registry";
import { AdapterError } from "./errors";
import { joinUrl, requestJson } from "./http";
import { listModelsFrom } from "./models";
import { presetOf } from "./preset";
import { DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_MAX_TURNS, type Driver, runToolLoop } from "./tool-loop";
import type {
  AdapterCapabilities,
  AgentAdapter,
  AgentConfig,
  ConnectorConfig,
  FetchLike,
  HealthStatus,
  ModelInfo,
  RunContext,
  RunInput,
  SecretHandle,
} from "./types";

export interface ApiFamily {
  key: string;
  /** Headers for every request (auth + vendor version headers). */
  headers(config: ConnectorConfig, credential: SecretHandle | null): Record<string, string>;
  driver(config: AgentConfig, ctx: RunContext): Driver;
}

export function createApiAdapter(family: ApiFamily): AgentAdapter {
  async function list(
    config: ConnectorConfig,
    ctx: { credential: SecretHandle | null; fetch: FetchLike },
  ): Promise<{ models: ModelInfo[]; latencyMs: number }> {
    const { path, shape, fromOrigin } = presetOf(config).models;
    if (!path || shape === "none")
      return { models: presetOf(config).models.static.map((id) => ({ id })), latencyMs: 0 };
    return listModelsFrom({
      fetch: ctx.fetch,
      baseUrl: config.baseUrl,
      path,
      shape,
      fromOrigin,
      headers: family.headers(config, ctx.credential),
    });
  }

  return {
    key: family.key,
    route: "api",

    capabilities(config: AgentConfig): AdapterCapabilities {
      return {
        taskTypes: registry().taskTypesOf(config.connector.registryKey),
        // Through the internal tool loop, when the runner gives the attempt a sandbox (code and data tasks).
        editsFiles: true,
        runsCode: true,
        browses: false,
        producesMedia: [],
        streaming: false,
        supportsMcpTools: false,
        supportsResume: false,
        runnerModes: ["cloud", "local"],
      };
    },

    async healthCheck(config, ctx): Promise<HealthStatus> {
      const started = performance.now();
      try {
        const health = presetOf(config).health;
        if (health.kind === "models") {
          const { models, latencyMs } = await list(config, ctx);
          return { ok: true, latencyMs, detail: `${models.length} models available` };
        }
        const headers = family.headers(config, ctx.credential);
        if (health.kind === "get") {
          const res = await requestJson({
            fetch: ctx.fetch,
            url: joinUrl(config.baseUrl, health.path),
            headers,
            timeoutMs: 30_000,
          });
          return { ok: true, latencyMs: res.latencyMs, detail: "key accepted" };
        }
        // Probe: an empty generation request. A bad key is rejected before validation (401/403); a good key gets a
        // validation error (400/422), and nothing is generated or billed.
        try {
          await requestJson({
            fetch: ctx.fetch,
            url: joinUrl(config.baseUrl, health.path),
            headers,
            body: {},
            retries: 0,
            timeoutMs: 30_000,
          });
        } catch (e) {
          if (e instanceof AdapterError && e.code === "bad_request")
            return { ok: true, latencyMs: Math.round(performance.now() - started), detail: "key accepted" };
          throw e;
        }
        return { ok: true, latencyMs: Math.round(performance.now() - started), detail: "key accepted" };
      } catch (e) {
        const err = e instanceof AdapterError ? e : new AdapterError("network", (e as Error).message);
        ctx.logger.warn({ code: err.code, status: err.status }, "health check failed");
        return {
          ok: false,
          latencyMs: Math.round(performance.now() - started),
          error: err.message,
          code: err.code,
        };
      }
    },

    async listModels(config, ctx) {
      return (await list(config, ctx)).models;
    },

    async estimate(input: RunInput, config: AgentConfig) {
      const price = config.price ?? (presetOf(config.connector).pricing.free ? FREE : null);
      if (!price) throw new AdapterError("misconfigured", `no price for ${config.model}`);
      const turns = Math.min(3, input.limits.maxTurns ?? DEFAULT_MAX_TURNS);
      const usd = estimateCost(
        {
          promptChars: config.rolePrompt.length + input.instructions.length + 2000,
          maxOutputTokens: input.limits.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          turns,
        },
        price,
      );
      return { usd, minutes: Math.min(input.limits.maxMinutes, turns) };
    },

    async run(input, config, ctx) {
      return runToolLoop(family.driver(config, ctx), input, config, ctx);
    },
  };
}
