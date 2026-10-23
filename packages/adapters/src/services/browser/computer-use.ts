// Claude computer use (docs/vendors/research-browser.md §10): the Messages API with the computer_toolset_20260801
// toolset plans actions; Brio runs them on a browser in the attempt's browser sandbox and returns what happened, every
// tool_use answered in order (after a failure the rest are answered "not executed"). Old screenshots leave the context
// as it grows. A person is asked (ask_person) before anything irreversible; no answer is no.
import { browseHostsOf, costOf, roundUsd } from "@brio/core";
import { AdapterError, isLimitAbort } from "../../errors";
import type { AgentAdapter, ProducedFile, RunInput, RunResult } from "../../types";
import { ServiceClient } from "../client";
import { QUESTION_WAIT_MS } from "../job";
import { type Actuator, type Screen, sandboxActuator } from "./actuator";
import { BROWSER_RULES, browserCapabilities } from "./browser-use";
import { cdpActuator } from "./cdp";

export const TOOLSET = "computer_toolset_20260801";
const KEEP_SCREENSHOTS = 3;
const NOT_EXECUTED = "Not executed: an earlier computer action in this turn failed.";

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; toolset_name?: string; input: Record<string, unknown> }
  | { type: string; [k: string]: unknown };
type Content =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: "image/png"; data: string } };
type ToolResult = {
  type: "tool_result";
  tool_use_id: string;
  toolset_name?: string;
  is_error?: boolean;
  content: Content[];
};
type Message = { role: "user" | "assistant"; content: string | Array<Block | ToolResult> };
type Answer = {
  id?: string;
  content?: Block[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

const ASK_PERSON = {
  name: "ask_person",
  description:
    "Ask the person who owns this task a question and wait for the answer. Use it before anything irreversible (buying, sending, publishing, deleting, submitting) and when a page needs a sign-in.",
  input_schema: {
    type: "object",
    properties: { question: { type: "string" } },
    required: ["question"],
    additionalProperties: false,
  },
};

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

/** The page to start on: the contract's first url input, else the first link in its objective or constraints. */
export function startUrl(input: RunInput): string | null {
  const c = input.contract;
  const fromInputs = c.inputs.find((i) => i.kind === "url" && /^https?:\/\//.test(i.ref))?.ref;
  return fromInputs ?? [c.objective, ...c.constraints].join(" ").match(URL_RE)?.[0] ?? null;
}

/** Drops all but the newest screenshots from earlier tool results (they cost ~1,500 tokens each, every turn). */
export function pruneScreenshots(messages: Message[], keep = KEEP_SCREENSHOTS): void {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user" || typeof m.content === "string") continue;
    for (const part of m.content) {
      if (part.type !== "tool_result") continue;
      const r = part as ToolResult;
      if (!r.content.some((c) => c.type === "image")) continue;
      seen++;
      if (seen > keep)
        r.content = [{ type: "text", text: "(an earlier screenshot, removed to save context)" }];
    }
  }
}

const png = (bytes: Uint8Array): Content => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data: Buffer.from(bytes).toString("base64") },
});

export function createComputerUse(
  makeActuator: (
    ctx: Parameters<AgentAdapter["run"]>[2],
    input: RunInput,
    config: Parameters<AgentAdapter["run"]>[1],
  ) => Actuator,
): AgentAdapter {
  return {
    key: "anthropic-computer-use",
    route: "browser",
    capabilities: browserCapabilities(),
    healthCheck: (config, ctx) => new ServiceClient(config, ctx).check(),
    async estimate(input) {
      return { usd: 0.5, minutes: Math.min(input.limits.maxMinutes, 20) };
    },

    async run(input, config, ctx): Promise<RunResult> {
      const started = performance.now();
      const api = new ServiceClient(config.connector, {
        credential: ctx.credential,
        fetch: ctx.fetch,
        signal: ctx.signal,
      });
      const tokens = {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      };
      let usd = 0;
      const said: string[] = [];
      const files: ProducedFile[] = [];
      const result = (status: RunResult["status"], extra: Partial<RunResult> = {}): RunResult => ({
        status,
        summary: said.at(-1)?.slice(0, 600) ?? "",
        output: said.join("\n\n"),
        artifacts: [],
        files,
        usage: {
          usd: roundUsd(usd),
          tokensIn: tokens.inputTokens,
          tokensOut: tokens.outputTokens,
          seconds: Math.round((performance.now() - started) / 1000),
        },
        tokens,
        ...extra,
      });

      const screen: Screen = {
        width: Number(config.options?.screenWidth ?? 1280),
        height: Number(config.options?.screenHeight ?? 800),
      };
      const url = startUrl(input);
      let actuator: Actuator;
      try {
        actuator = makeActuator(ctx, input, config);
        await actuator.open(url, screen);
      } catch (e) {
        return result("failed", { error: `the browser did not start: ${(e as Error).message}` });
      }

      const system = [
        config.rolePrompt,
        `You operate a Chromium browser on a ${screen.width}x${screen.height} screen${url ? `, opened at ${url}` : ""}. Take a screenshot first. Work step by step and check each step with a screenshot.`,
        `Rules: ${BROWSER_RULES} Before any irreversible step, call ask_person and go on only if the answer is yes.`,
        "When you are done, reply with the result in plain text (what you found or did), without calling a tool.",
      ]
        .filter(Boolean)
        .join("\n\n");
      const messages: Message[] = [{ role: "user", content: input.instructions }];
      const maxTurns = input.limits.maxTurns ?? 40;

      try {
        for (let turn = 0; turn < maxTurns; turn++) {
          if (ctx.signal.aborted) throw ctx.signal.reason ?? new AdapterError("cancelled", "cancelled");
          pruneScreenshots(messages);
          const a = await api.json<Answer>(
            "POST",
            "/v1/messages",
            {
              model: config.model,
              max_tokens: Math.min(input.limits.maxOutputTokens ?? 4096, 8192),
              system,
              tools: [{ type: TOOLSET, configs: { zoom: { enabled: true } } }, ASK_PERSON],
              messages,
            },
            { retries: 2, timeoutMs: 5 * 60_000 },
          );
          const u = {
            inputTokens: a.usage?.input_tokens ?? 0,
            outputTokens: a.usage?.output_tokens ?? 0,
            cachedInputTokens: a.usage?.cache_read_input_tokens ?? 0,
            cacheWriteTokens: a.usage?.cache_creation_input_tokens ?? 0,
            reasoningTokens: 0,
          };
          const turnUsd = config.price ? costOf(u, config.price) : 0;
          usd += turnUsd;
          for (const k of Object.keys(tokens) as Array<keyof typeof tokens>) tokens[k] += u[k];
          ctx.emit({
            kind: "cost",
            usd: turnUsd,
            tokensIn: u.inputTokens,
            tokensOut: u.outputTokens,
            model: config.model,
            priceSource: "table",
          });
          if (usd > input.limits.maxCostUsd)
            return result("limit_exceeded", {
              error: `spent $${usd.toFixed(2)}, over the $${input.limits.maxCostUsd} limit`,
            });

          const content = a.content ?? [];
          messages.push({ role: "assistant", content });
          for (const b of content)
            if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
              said.push(b.text.trim());
              ctx.emit({ kind: "message", role: "assistant", text: b.text.trim() });
            }
          const uses = content.filter(
            (b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use",
          );
          if (a.stop_reason !== "tool_use" || !uses.length) {
            files.push({
              kind: "image",
              name: "final-screen.png",
              contentType: "image/png",
              bytes: await actuator.screenshot().catch(() => new Uint8Array()),
            });
            if (!files[0]?.bytes.length) files.length = 0;
            return result("completed", { vendorRunId: a.id ?? "" });
          }

          // Every tool_use gets its result, in order, in one user message.
          const results: ToolResult[] = [];
          let failed = false;
          for (const b of uses) {
            const computer = b.toolset_name === "computer";
            const base = {
              type: "tool_result" as const,
              tool_use_id: b.id,
              ...(computer ? { toolset_name: "computer" } : {}),
            };
            if (failed) {
              results.push({ ...base, is_error: true, content: [{ type: "text", text: NOT_EXECUTED }] });
              continue;
            }
            ctx.emit({
              kind: "tool_call",
              name: computer ? `computer.${b.name}` : b.name,
              args: b.name === "type" ? { text: "(typed text)" } : b.input,
            });
            try {
              if (computer && b.name === "screenshot")
                results.push({ ...base, content: [png(await actuator.screenshot())] });
              else if (computer && b.name === "zoom") {
                const r = b.input.region;
                if (!Array.isArray(r) || r.length !== 4) throw new Error("region must be [x0, y0, x1, y1]");
                results.push({
                  ...base,
                  content: [
                    png(await actuator.screenshot(r.map(Number) as [number, number, number, number])),
                  ],
                });
              } else if (computer)
                results.push({
                  ...base,
                  content: [{ type: "text", text: await actuator.act(b.name, b.input) }],
                });
              else if (b.name === "ask_person") {
                const question = String(b.input.question ?? "").slice(0, 2000);
                ctx.emit({ kind: "needs_input", question });
                const reply = ctx.tools?.mailbox
                  ? await ctx.tools.mailbox.askUser(question, { waitMs: QUESTION_WAIT_MS })
                  : null;
                results.push({
                  ...base,
                  content: [{ type: "text", text: reply ?? "No answer. Treat it as no: do not do it." }],
                });
              } else throw new Error(`unknown tool ${b.name}`);
            } catch (e) {
              failed = true;
              results.push({
                ...base,
                is_error: true,
                content: [{ type: "text", text: (e as Error).message.slice(0, 500) }],
              });
            }
          }
          messages.push({ role: "user", content: results });
        }
        return result("failed", { error: `stopped after ${maxTurns} turns without finishing` });
      } catch (e) {
        if (ctx.signal.aborted)
          return result(isLimitAbort(ctx.signal) ? "limit_exceeded" : "cancelled", {
            error: (ctx.signal.reason as Error | undefined)?.message ?? "cancelled",
          });
        return result("failed", { error: e instanceof AdapterError ? e.message : (e as Error).message });
      } finally {
        await actuator.close().catch(() => {});
      }
    },
  };
}

/**
 * The browser a run drives: Brio's sandboxed one, or — when the agent asks for options.browser = "cloud" — a session on
 * the workspace's cloud browser, held to the same site allowlist inside the browser.
 */
export function actuatorFor(
  ctx: Parameters<AgentAdapter["run"]>[2],
  input: RunInput,
  config: Parameters<AgentAdapter["run"]>[1],
): Actuator {
  if (config.options?.browser !== "cloud") return sandboxActuator(ctx.sandbox);
  const provider = ctx.tools?.browser;
  if (!provider)
    throw new AdapterError("misconfigured", "this agent uses a cloud browser, and the workspace has none");
  let inner: Actuator | null = null;
  const ready = () => {
    if (!inner) throw new Error("the browser is not open");
    return inner;
  };
  return {
    async open(url, screen) {
      const s = await provider.session({
        ...screen,
        timeoutS: input.limits.maxMinutes * 60 + 60,
        signal: ctx.signal,
      });
      inner = cdpActuator({ url: s.url, allow: browseHostsOf(input.contract), release: () => s.release() });
      await inner.open(url, screen);
    },
    screenshot: (r) => ready().screenshot(r),
    act: (n, i) => ready().act(n, i),
    close: async () => inner?.close(),
  };
}

export const computerUse = createComputerUse(actuatorFor);
