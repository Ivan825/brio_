// Live model listing (CLAUDE.md rule 8: model names are data). One parser per list shape in the registry.
import type { ModelPrice } from "@brio/core";
import type { ModelListShape } from "@brio/registry";
import { AdapterError } from "./errors";
import { joinUrl, requestJson } from "./http";
import type { FetchLike, ModelInfo } from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function arrayAt(body: unknown, key: string): Obj[] {
  if (!isObj(body) || !Array.isArray(body[key]))
    throw new AdapterError("invalid_response", `model list has no "${key}" array`);
  return (body[key] as unknown[]).filter(isObj);
}

/** OpenRouter prices are USD per token as decimal strings; ours are per million. */
function perM(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : num(v);
  return n === undefined || !Number.isFinite(n) || n < 0 ? undefined : Math.round(n * 1e6 * 1e6) / 1e6;
}

export function openRouterPrice(pricing: unknown): ModelPrice | undefined {
  if (!isObj(pricing)) return undefined;
  const inputPerM = perM(pricing.prompt);
  const outputPerM = perM(pricing.completion);
  if (inputPerM === undefined || outputPerM === undefined) return undefined;
  return {
    inputPerM,
    outputPerM,
    cachedInputPerM: perM(pricing.input_cache_read) ?? null,
    cacheWritePerM: perM(pricing.input_cache_write) ?? null,
  };
}

export function parseOpenAIModels(body: unknown): ModelInfo[] {
  return arrayAt(body, "data").flatMap((m) => {
    if (typeof m.id !== "string") return [];
    const created = num(m.created);
    const ctx = num(m.context_length) ?? num(m.context_window) ?? num(m.max_model_len);
    return [
      {
        id: m.id,
        ...(typeof m.name === "string" ? { displayName: m.name } : {}),
        ...(ctx ? { contextTokens: ctx } : {}),
        ...(created ? { createdAt: new Date(created * 1000).toISOString() } : {}),
      },
    ];
  });
}

export function parseOpenRouterModels(body: unknown): ModelInfo[] {
  return arrayAt(body, "data").flatMap((m) => {
    if (typeof m.id !== "string") return [];
    const price = openRouterPrice(m.pricing);
    const top = isObj(m.top_provider) ? m.top_provider : {};
    const created = num(m.created);
    return [
      {
        id: m.id,
        ...(typeof m.name === "string" ? { displayName: m.name } : {}),
        ...(num(m.context_length) ? { contextTokens: num(m.context_length) } : {}),
        ...(num(top.max_completion_tokens) ? { maxOutputTokens: num(top.max_completion_tokens) } : {}),
        ...(price ? { price } : {}),
        ...(Array.isArray(m.supported_parameters)
          ? {
              capabilities: (m.supported_parameters as unknown[]).filter(
                (p): p is string => typeof p === "string",
              ),
            }
          : {}),
        ...(created ? { createdAt: new Date(created * 1000).toISOString() } : {}),
      },
    ];
  });
}

/** xAI lists prices as integer US cents per 100M tokens: $/M = value / 10,000. */
export function parseXaiModels(body: unknown): ModelInfo[] {
  const cents = (v: unknown) => {
    const n = num(v);
    return n === undefined || n < 0 ? undefined : n / 10_000;
  };
  return arrayAt(body, "data").flatMap((m) => {
    if (typeof m.id !== "string") return [];
    const inputPerM = cents(m.prompt_text_token_price);
    const outputPerM = cents(m.completion_text_token_price);
    const threshold = num(m.long_context_threshold);
    const longIn = cents(m.prompt_text_token_price_long_context);
    const longOut = cents(m.completion_text_token_price_long_context);
    const price: ModelPrice | undefined =
      inputPerM !== undefined && outputPerM !== undefined
        ? {
            inputPerM,
            outputPerM,
            cachedInputPerM: cents(m.cached_prompt_text_token_price) ?? null,
            cacheWritePerM: null,
            longContext:
              threshold && longIn !== undefined && longOut !== undefined
                ? {
                    thresholdTokens: threshold,
                    inputPerM: longIn,
                    outputPerM: longOut,
                    cachedInputPerM: cents(m.cached_prompt_text_token_price_long_context) ?? null,
                  }
                : null,
          }
        : undefined;
    const created = num(m.created);
    return [
      {
        id: m.id,
        ...(num(m.context_length) ? { contextTokens: num(m.context_length) } : {}),
        ...(price ? { price } : {}),
        ...(created ? { createdAt: new Date(created * 1000).toISOString() } : {}),
      },
    ];
  });
}

/** Alibaba Model Studio's native list: prices as strings per million tokens, first (smallest) tier. */
export function parseDashscopeModels(body: unknown): { models: ModelInfo[]; total: number } {
  const output = isObj(body) && isObj(body.output) ? body.output : null;
  if (!output || !Array.isArray(output.models))
    throw new AdapterError("invalid_response", 'model list has no "output.models" array');
  const models = output.models.filter(isObj).flatMap((m): ModelInfo[] => {
    if (typeof m.model !== "string") return [];
    const info = isObj(m.model_info) ? m.model_info : {};
    const tier = Array.isArray(m.prices) && isObj(m.prices[0]) ? m.prices[0] : null;
    const entries = tier && Array.isArray(tier.prices) ? tier.prices.filter(isObj) : [];
    const priceOf = (type: string) => {
      const e = entries.find((x) => x.type === type);
      const n = e ? Number(e.price) : Number.NaN;
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    };
    const inputPerM = priceOf("input_token");
    const outputPerM = priceOf("output_token");
    return [
      {
        id: m.model,
        ...(typeof m.name === "string" ? { displayName: m.name } : {}),
        ...(num(info.context_window) ? { contextTokens: num(info.context_window) } : {}),
        ...(num(info.max_output_tokens) ? { maxOutputTokens: num(info.max_output_tokens) } : {}),
        ...(inputPerM !== undefined && outputPerM !== undefined
          ? { price: { inputPerM, outputPerM, cachedInputPerM: null, cacheWritePerM: null } }
          : {}),
      },
    ];
  });
  return { models, total: num(output.total) ?? models.length };
}

/** Together has returned both a bare array and {data:[...]}; prices are per million tokens. */
export function parseTogetherModels(body: unknown): ModelInfo[] {
  const list = Array.isArray(body) ? body.filter(isObj) : arrayAt(body, "data");
  return list.flatMap((m) => {
    if (typeof m.id !== "string") return [];
    if (typeof m.type === "string" && m.type !== "chat" && m.type !== "language") return [];
    const pricing = isObj(m.pricing) ? m.pricing : {};
    const inputPerM = num(pricing.input);
    const outputPerM = num(pricing.output);
    return [
      {
        id: m.id,
        ...(typeof m.display_name === "string" ? { displayName: m.display_name } : {}),
        ...(num(m.context_length) ? { contextTokens: num(m.context_length) } : {}),
        ...(inputPerM !== undefined && outputPerM !== undefined && inputPerM + outputPerM > 0
          ? {
              price: {
                inputPerM,
                outputPerM,
                cachedInputPerM: num(pricing.cached_input) ?? null,
                cacheWritePerM: null,
              },
            }
          : {}),
      },
    ];
  });
}

export function parseAnthropicModels(body: unknown): ModelInfo[] {
  return arrayAt(body, "data").flatMap((m) => {
    if (typeof m.id !== "string") return [];
    const ctx = num(m.max_input_tokens);
    const out = num(m.max_tokens);
    return [
      {
        id: m.id,
        ...(typeof m.display_name === "string" ? { displayName: m.display_name } : {}),
        ...(ctx ? { contextTokens: ctx } : {}),
        ...(out ? { maxOutputTokens: out } : {}),
        ...(typeof m.created_at === "string" ? { createdAt: m.created_at } : {}),
      },
    ];
  });
}

export function parseGeminiModels(body: unknown): ModelInfo[] {
  return arrayAt(body, "models").flatMap((m) => {
    if (typeof m.name !== "string") return [];
    const methods = Array.isArray(m.supportedGenerationMethods)
      ? (m.supportedGenerationMethods as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    // Only models that can hold a conversation are agents; embedding-only models are left out.
    if (methods.length > 0 && !methods.includes("generateContent")) return [];
    return [
      {
        id: m.name.replace(/^models\//, ""),
        ...(typeof m.displayName === "string" ? { displayName: m.displayName } : {}),
        ...(num(m.inputTokenLimit) ? { contextTokens: num(m.inputTokenLimit) } : {}),
        ...(num(m.outputTokenLimit) ? { maxOutputTokens: num(m.outputTokenLimit) } : {}),
        capabilities: methods,
      },
    ];
  });
}

export interface ListModelsRequest {
  fetch: FetchLike;
  baseUrl: string;
  path: string;
  shape: ModelListShape;
  /** Resolve path against the base URL's origin. */
  fromOrigin?: boolean;
  headers: Record<string, string>;
  signal?: AbortSignal;
}

/** Fetches every page of a model list. Stops after 20 pages so a misbehaving endpoint cannot loop forever. */
export async function listModelsFrom(
  req: ListModelsRequest,
): Promise<{ models: ModelInfo[]; latencyMs: number }> {
  if (req.shape === "none") return { models: [], latencyMs: 0 };
  const out: ModelInfo[] = [];
  let latencyMs = 0;
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const url = new URL(
      req.fromOrigin ? joinUrl(new URL(req.baseUrl).origin, req.path) : joinUrl(req.baseUrl, req.path),
    );
    if (req.shape === "dashscope") {
      url.searchParams.set("page_size", "100");
      url.searchParams.set("page_no", String(page + 1));
    }
    if (req.shape === "anthropic") {
      url.searchParams.set("limit", "1000");
      if (cursor) url.searchParams.set("after_id", cursor);
    } else if (req.shape === "gemini") {
      url.searchParams.set("pageSize", "1000");
      if (cursor) url.searchParams.set("pageToken", cursor);
    }
    const res = await requestJson({
      fetch: req.fetch,
      url: url.toString(),
      headers: req.headers,
      timeoutMs: 30_000,
      ...(req.signal ? { signal: req.signal } : {}),
    });
    latencyMs += res.latencyMs;
    const body = res.data as Obj;
    switch (req.shape) {
      case "openai":
        return { models: [...out, ...parseOpenAIModels(body)], latencyMs };
      case "xai":
        return { models: [...out, ...parseXaiModels(body)], latencyMs };
      case "together":
        return { models: [...out, ...parseTogetherModels(res.data)], latencyMs };
      case "dashscope": {
        const { models, total } = parseDashscopeModels(body);
        out.push(...models);
        if (models.length === 0 || out.length >= total) return { models: out, latencyMs };
        cursor = "next";
        break;
      }
      case "openrouter":
        return { models: [...out, ...parseOpenRouterModels(body)], latencyMs };
      case "anthropic":
        out.push(...parseAnthropicModels(body));
        cursor = body.has_more === true && typeof body.last_id === "string" ? body.last_id : undefined;
        break;
      case "gemini":
        out.push(...parseGeminiModels(body));
        cursor =
          typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : undefined;
        break;
    }
    if (!cursor) break;
  }
  return { models: out, latencyMs };
}
