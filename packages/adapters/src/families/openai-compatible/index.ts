// One adapter, many vendors: anything that speaks OpenAI Chat Completions or Responses (ADAPTER_SPEC §2.1).
import { type TokenUsage, ZERO_USAGE } from "@brio/core";
import { createApiAdapter } from "../../api-adapter";
import { AdapterError } from "../../errors";
import { authHeaders, joinUrl, requestJson } from "../../http";
import type { Driver, ToolCall, Turn, TurnRequest } from "../../tool-loop";
import type { AgentConfig, ConnectorConfig, RunContext, SecretHandle } from "../../types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

function parseArgs(raw: unknown): Record<string, unknown> {
  if (isObj(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return isObj(v) ? v : { value: v };
  } catch {
    // The model produced malformed JSON; the tool will report the missing arguments back to it.
    return { _raw: raw };
  }
}

/**
 * The call's cost when the vendor reports it: OpenRouter `usage.cost` (USD), xAI `cost_in_usd_ticks` (10^10 ticks = $1)
 * or `cost_in_nano_usd`.
 */
export function vendorCost(usage: unknown): number | undefined {
  if (!isObj(usage)) return undefined;
  if (typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0) return usage.cost;
  if (typeof usage.cost_in_usd_ticks === "number" && usage.cost_in_usd_ticks >= 0)
    return usage.cost_in_usd_ticks / 1e10;
  if (typeof usage.cost_in_nano_usd === "number" && usage.cost_in_nano_usd >= 0)
    return usage.cost_in_nano_usd / 1e9;
  return undefined;
}

/** A cost header (LiteLLM's x-litellm-response-cost); ignored when absent, unparseable or zero (no cost map). */
function headerCost(headers: Headers, name: string | undefined): number | undefined {
  if (!name) return undefined;
  const v = Number(headers.get(name));
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

// ---- Chat Completions ----------------------------------------------------------------------------------------------

/** prompt_tokens includes cached tokens; completion_tokens includes reasoning. */
export function chatUsage(u: unknown): TokenUsage {
  if (!isObj(u)) return ZERO_USAGE;
  const prompt = n(u.prompt_tokens);
  const details = isObj(u.prompt_tokens_details) ? u.prompt_tokens_details : {};
  // DeepSeek (prompt_cache_hit_tokens), Kimi and Together (cached_tokens) report cache hits at the top level.
  const cached = Math.min(
    prompt,
    n(details.cached_tokens) || n(u.prompt_cache_hit_tokens) || n(u.cached_tokens),
  );
  const cacheWrite = Math.min(prompt - cached, n(details.cache_write_tokens));
  const out = isObj(u.completion_tokens_details) ? u.completion_tokens_details : {};
  return {
    inputTokens: prompt - cached - cacheWrite,
    cachedInputTokens: cached,
    cacheWriteTokens: cacheWrite,
    outputTokens: n(u.completion_tokens),
    reasoningTokens: n(out.reasoning_tokens),
  };
}

function chatMessages(req: TurnRequest): Obj[] {
  const out: Obj[] = [{ role: "system", content: req.system }];
  for (const m of req.messages) {
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "assistant")
      out.push({
        role: "assistant",
        content: m.text || null,
        ...(m.toolCalls.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            }
          : {}),
      });
    else for (const r of m.results) out.push({ role: "tool", tool_call_id: r.call.id, content: r.output });
  }
  return out;
}

export function parseChatResponse(body: unknown): Turn {
  if (!isObj(body) || !Array.isArray(body.choices) || !isObj(body.choices[0]))
    throw new AdapterError("invalid_response", "chat completion has no choices");
  const choice = body.choices[0] as Obj;
  const msg = isObj(choice.message) ? choice.message : {};
  const toolCalls: ToolCall[] = (Array.isArray(msg.tool_calls) ? msg.tool_calls : [])
    .filter(isObj)
    .map((c, i) => {
      const fn = isObj(c.function) ? c.function : {};
      return {
        id: typeof c.id === "string" ? c.id : `call_${i}`,
        name: String(fn.name ?? ""),
        args: parseArgs(fn.arguments),
      };
    });
  const finish = choice.finish_reason;
  const cost = vendorCost(body.usage);
  return {
    text: typeof msg.content === "string" ? msg.content : "",
    toolCalls,
    usage: chatUsage(body.usage),
    ...(cost !== undefined ? { vendorCostUsd: cost } : {}),
    stop:
      toolCalls.length > 0
        ? "tool_use"
        : finish === "length"
          ? "max_tokens"
          : typeof msg.refusal === "string" && msg.refusal
            ? "refusal"
            : finish === "stop"
              ? "end"
              : "other",
    ...(typeof body.id === "string" ? { vendorId: body.id } : {}),
  };
}

function chatDriver(config: AgentConfig, ctx: RunContext): Driver {
  const c = config.connector;
  return async (req, signal) => {
    const body: Obj = {
      ...c.preset.requestExtras,
      ...req.options,
      model: req.model,
      messages: chatMessages(req),
      [c.preset.maxTokensParam]: req.maxOutputTokens,
    };
    if (req.tools.length && c.preset.tools)
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    const res = await requestJson({
      fetch: ctx.fetch,
      url: joinUrl(c.baseUrl, "/chat/completions"),
      headers: headers(c, ctx.credential),
      body,
      signal,
    });
    const turn = parseChatResponse(res.data);
    const fromHeader = headerCost(res.headers, c.preset.costHeader);
    return fromHeader !== undefined && turn.vendorCostUsd === undefined
      ? { ...turn, vendorCostUsd: fromHeader }
      : turn;
  };
}

// ---- Responses -----------------------------------------------------------------------------------------------------

/** input_tokens includes cached tokens; output_tokens includes reasoning. */
export function responsesUsage(u: unknown): TokenUsage {
  if (!isObj(u)) return ZERO_USAGE;
  const input = n(u.input_tokens);
  const details = isObj(u.input_tokens_details) ? u.input_tokens_details : {};
  const cached = Math.min(input, n(details.cached_tokens));
  const cacheWrite = Math.min(input - cached, n(details.cache_write_tokens));
  const out = isObj(u.output_tokens_details) ? u.output_tokens_details : {};
  return {
    inputTokens: input - cached - cacheWrite,
    cachedInputTokens: cached,
    cacheWriteTokens: cacheWrite,
    outputTokens: n(u.output_tokens),
    reasoningTokens: n(out.reasoning_tokens),
  };
}

function responsesInput(req: TurnRequest): unknown[] {
  const out: unknown[] = [];
  for (const m of req.messages) {
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "assistant") {
      // Echo the model's own output items (reasoning, messages, calls) so the next turn continues statelessly.
      if (Array.isArray(m.vendor)) out.push(...m.vendor);
      else {
        if (m.text) out.push({ role: "assistant", content: m.text });
        for (const c of m.toolCalls)
          out.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) });
      }
    } else
      for (const r of m.results)
        out.push({ type: "function_call_output", call_id: r.call.id, output: r.output });
  }
  return out;
}

export function parseResponsesResponse(body: unknown): Turn {
  if (!isObj(body) || !Array.isArray(body.output))
    throw new AdapterError("invalid_response", "response has no output");
  if (body.status === "failed") {
    const err = isObj(body.error) ? String(body.error.message ?? "failed") : "failed";
    throw new AdapterError("unavailable", `the response failed: ${err}`);
  }
  const items = body.output.filter(isObj);
  const texts: string[] = [];
  let refused = false;
  const toolCalls: ToolCall[] = [];
  for (const item of items) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content.filter(isObj)) {
        if (part.type === "output_text" && typeof part.text === "string") texts.push(part.text);
        if (part.type === "refusal") refused = true;
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: String(item.call_id ?? item.id ?? `call_${toolCalls.length}`),
        name: String(item.name ?? ""),
        args: parseArgs(item.arguments),
      });
    }
  }
  const incomplete = body.status === "incomplete";
  const cost = vendorCost(body.usage);
  return {
    text: texts.join("\n"),
    toolCalls,
    usage: responsesUsage(body.usage),
    ...(cost !== undefined ? { vendorCostUsd: cost } : {}),
    stop: toolCalls.length ? "tool_use" : refused ? "refusal" : incomplete ? "max_tokens" : "end",
    ...(typeof body.id === "string" ? { vendorId: body.id } : {}),
    vendor: items,
  };
}

function responsesDriver(config: AgentConfig, ctx: RunContext): Driver {
  const c = config.connector;
  return async (req, signal) => {
    const body: Obj = {
      ...c.preset.requestExtras,
      ...req.options,
      model: req.model,
      instructions: req.system,
      input: responsesInput(req),
      max_output_tokens: req.maxOutputTokens,
      // e.g. OpenAI: store nothing at the vendor and carry reasoning between turns encrypted.
      ...c.preset.responsesExtras,
    };
    if (req.tools.length && c.preset.tools)
      body.tools = req.tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        strict: false,
      }));
    const res = await requestJson({
      fetch: ctx.fetch,
      url: joinUrl(c.baseUrl, "/responses"),
      headers: headers(c, ctx.credential),
      body,
      signal,
    });
    const turn = parseResponsesResponse(res.data);
    const fromHeader = headerCost(res.headers, c.preset.costHeader);
    return fromHeader !== undefined && turn.vendorCostUsd === undefined
      ? { ...turn, vendorCostUsd: fromHeader }
      : turn;
  };
}

function headers(c: ConnectorConfig, credential: SecretHandle | null): Record<string, string> {
  return { ...c.preset.extraHeaders, ...c.extraHeaders, ...authHeaders(c.preset.auth, credential) };
}

export const openaiCompatible = createApiAdapter({
  key: "openai-compatible",
  headers,
  driver(config, ctx) {
    const style = config.connector.apiStyle ?? config.connector.preset.apiStyles[0];
    if (!style || !config.connector.preset.apiStyles.includes(style))
      throw new AdapterError(
        "misconfigured",
        `${config.connector.presetKey} does not support the ${style} API`,
      );
    return style === "responses" ? responsesDriver(config, ctx) : chatDriver(config, ctx);
  },
});
