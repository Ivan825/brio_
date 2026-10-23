// Claude through the native Messages API (ADAPTER_SPEC §2.2): prompt caching and thinking blocks survive, which
// compatibility layers lose.
import { type TokenUsage, ZERO_USAGE } from "@brio/core";
import { createApiAdapter } from "../../api-adapter";
import { AdapterError } from "../../errors";
import { authHeaders, joinUrl, requestJson } from "../../http";
import type { Driver, ToolCall, Turn, TurnRequest } from "../../tool-loop";
import type { ConnectorConfig, SecretHandle } from "../../types";

export const ANTHROPIC_VERSION = "2023-06-01";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** Anthropic's input_tokens excludes cache reads and writes, so the buckets map one to one. */
export function anthropicUsage(u: unknown): TokenUsage {
  if (!isObj(u)) return ZERO_USAGE;
  return {
    inputTokens: n(u.input_tokens),
    cachedInputTokens: n(u.cache_read_input_tokens),
    cacheWriteTokens: n(u.cache_creation_input_tokens),
    outputTokens: n(u.output_tokens),
    reasoningTokens: 0,
  };
}

const EPHEMERAL = { type: "ephemeral" } as const;

function messages(req: TurnRequest): Obj[] {
  const out: Obj[] = [];
  for (const m of req.messages) {
    if (m.role === "user") out.push({ role: "user", content: [{ type: "text", text: m.text }] });
    else if (m.role === "assistant") {
      const content = Array.isArray(m.vendor)
        ? m.vendor
        : [
            ...(m.text ? [{ type: "text", text: m.text }] : []),
            ...m.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.args })),
          ];
      out.push({ role: "assistant", content });
    } else
      out.push({
        role: "user",
        content: m.results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.call.id,
          content: r.output,
          ...(r.isError ? { is_error: true } : {}),
        })),
      });
  }
  // Cache the conversation so far: each tool-loop turn then pays cache-read prices for everything before it.
  const last = out.at(-1);
  if (last && Array.isArray(last.content) && last.content.length) {
    const blocks = last.content as Obj[];
    blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: EPHEMERAL };
  }
  return out;
}

export function parseMessage(body: unknown): Turn {
  if (!isObj(body) || !Array.isArray(body.content))
    throw new AdapterError("invalid_response", "message has no content");
  const blocks = body.content.filter(isObj);
  const text = blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
  const toolCalls: ToolCall[] = blocks
    .filter((b) => b.type === "tool_use")
    .map((b, i) => ({
      id: typeof b.id === "string" ? b.id : `toolu_${i}`,
      name: String(b.name ?? ""),
      args: isObj(b.input) ? b.input : {},
    }));
  const reason = body.stop_reason;
  return {
    text,
    toolCalls,
    usage: anthropicUsage(body.usage),
    stop:
      reason === "tool_use"
        ? "tool_use"
        : reason === "max_tokens"
          ? "max_tokens"
          : reason === "refusal"
            ? "refusal"
            : reason === "end_turn" || reason === "stop_sequence"
              ? "end"
              : "other",
    ...(typeof body.id === "string" ? { vendorId: body.id } : {}),
    vendor: blocks,
  };
}

function headers(c: ConnectorConfig, credential: SecretHandle | null): Record<string, string> {
  return {
    "anthropic-version": ANTHROPIC_VERSION,
    ...c.preset.extraHeaders,
    ...c.extraHeaders,
    ...authHeaders(c.preset.auth, credential),
  };
}

export const anthropic = createApiAdapter({
  key: "anthropic",
  headers,
  driver(config, ctx): Driver {
    const c = config.connector;
    return async (req, signal) => {
      const body: Obj = {
        ...c.preset.requestExtras,
        ...req.options,
        model: req.model,
        max_tokens: req.maxOutputTokens,
        system: [{ type: "text", text: req.system, cache_control: EPHEMERAL }],
        messages: messages(req),
      };
      if (req.tools.length)
        body.tools = req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        }));
      const res = await requestJson({
        fetch: ctx.fetch,
        url: joinUrl(c.baseUrl, "/messages"),
        headers: headers(c, ctx.credential),
        body,
        signal,
      });
      return parseMessage(res.data);
    };
  },
});
