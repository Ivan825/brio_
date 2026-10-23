// Gemini through its native generateContent API (ADAPTER_SPEC §2.2). Thought signatures are echoed back verbatim so
// multi-turn tool use keeps the model's reasoning context.
import { type TokenUsage, ZERO_USAGE } from "@brio/core";
import { createApiAdapter } from "../../api-adapter";
import { AdapterError } from "../../errors";
import { authHeaders, joinUrl, requestJson } from "../../http";
import type { Driver, ToolCall, Turn, TurnRequest } from "../../tool-loop";
import type { ConnectorConfig, JsonSchema, SecretHandle } from "../../types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * promptTokenCount includes cached tokens; thoughts are billed as output on top of candidates. Tool-use prompt tokens
 * are billed as input.
 */
export function geminiUsage(u: unknown): TokenUsage {
  if (!isObj(u)) return ZERO_USAGE;
  const prompt = n(u.promptTokenCount) + n(u.toolUsePromptTokenCount);
  const cached = Math.min(prompt, n(u.cachedContentTokenCount));
  const thoughts = n(u.thoughtsTokenCount);
  return {
    inputTokens: prompt - cached,
    cachedInputTokens: cached,
    cacheWriteTokens: 0,
    outputTokens: n(u.candidatesTokenCount) + thoughts,
    reasoningTokens: thoughts,
  };
}

function contents(req: TurnRequest): Obj[] {
  const out: Obj[] = [];
  for (const m of req.messages) {
    if (m.role === "user") out.push({ role: "user", parts: [{ text: m.text }] });
    else if (m.role === "assistant") {
      const parts = Array.isArray(m.vendor)
        ? m.vendor
        : [
            ...(m.text ? [{ text: m.text }] : []),
            ...m.toolCalls.map((c) => ({ functionCall: { name: c.name, args: c.args } })),
          ];
      out.push({ role: "model", parts });
    } else
      out.push({
        role: "user",
        parts: m.results.map((r) => ({
          functionResponse: {
            name: r.call.name,
            ...(r.call.id.startsWith("gemini_") ? {} : { id: r.call.id }),
            response: r.isError ? { error: r.output } : { output: r.output },
          },
        })),
      });
  }
  return out;
}

export function parseGenerateContent(body: unknown): Turn {
  if (!isObj(body)) throw new AdapterError("invalid_response", "empty response");
  const feedback = isObj(body.promptFeedback) ? body.promptFeedback : {};
  const candidate = Array.isArray(body.candidates) && isObj(body.candidates[0]) ? body.candidates[0] : null;
  if (!candidate) {
    if (feedback.blockReason)
      return { text: "", toolCalls: [], usage: geminiUsage(body.usageMetadata), stop: "refusal" };
    throw new AdapterError("invalid_response", "response has no candidates");
  }
  const content = isObj(candidate.content) ? candidate.content : {};
  const parts = (Array.isArray(content.parts) ? content.parts : []).filter(isObj);
  const text = parts
    .filter((p) => typeof p.text === "string" && p.thought !== true)
    .map((p) => p.text as string)
    .join("");
  const toolCalls: ToolCall[] = parts
    .filter((p) => isObj(p.functionCall))
    .map((p, i) => {
      const fc = p.functionCall as Obj;
      return {
        id: typeof fc.id === "string" ? fc.id : `gemini_${i}`,
        name: String(fc.name ?? ""),
        args: isObj(fc.args) ? fc.args : {},
      };
    });
  const reason = candidate.finishReason;
  return {
    text,
    toolCalls,
    usage: geminiUsage(body.usageMetadata),
    stop: toolCalls.length
      ? "tool_use"
      : reason === "MAX_TOKENS"
        ? "max_tokens"
        : reason === "SAFETY" ||
            reason === "PROHIBITED_CONTENT" ||
            reason === "BLOCKLIST" ||
            reason === "RECITATION"
          ? "refusal"
          : reason === "STOP"
            ? "end"
            : "other",
    ...(typeof body.responseId === "string" ? { vendorId: body.responseId } : {}),
    vendor: parts,
  };
}

function headers(c: ConnectorConfig, credential: SecretHandle | null): Record<string, string> {
  return { ...c.preset.extraHeaders, ...c.extraHeaders, ...authHeaders(c.preset.auth, credential) };
}

/** Function declarations take the full JSON Schema via parametersJsonSchema. */
const declaration = (t: { name: string; description: string; parameters: JsonSchema }) => ({
  name: t.name,
  description: t.description,
  parametersJsonSchema: t.parameters,
});

export const gemini = createApiAdapter({
  key: "gemini",
  headers,
  driver(config, ctx): Driver {
    const c = config.connector;
    return async (req, signal) => {
      const { generationConfig, ...rest } = req.options as { generationConfig?: Obj };
      const body: Obj = {
        ...c.preset.requestExtras,
        ...rest,
        systemInstruction: { parts: [{ text: req.system }] },
        contents: contents(req),
        generationConfig: {
          ...(isObj(generationConfig) ? generationConfig : {}),
          maxOutputTokens: req.maxOutputTokens,
        },
      };
      if (req.tools.length) body.tools = [{ functionDeclarations: req.tools.map(declaration) }];
      const model = req.model.replace(/^models\//, "");
      const res = await requestJson({
        fetch: ctx.fetch,
        url: joinUrl(c.baseUrl, `/models/${encodeURIComponent(model)}:generateContent`),
        headers: headers(c, ctx.credential),
        body,
        signal,
      });
      return parseGenerateContent(res.data);
    };
  },
});
