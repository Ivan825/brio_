// CliAdapterBase (ADAPTER_SPEC §2.3): run an official coding CLI headless inside the attempt's sandbox, turn its
// NDJSON stream into AdapterEvents, meter it, enforce limits and kill it on cancel. Each CLI supplies only its argv,
// environment and event parser; vendor quirks stay in its own file.
import { addUsage, costOf, roundUsd, type TokenUsage, ZERO_USAGE } from "@brio/core";
import { registry } from "@brio/registry";
import { ADAPTERS_BY_FAMILY } from "../api-family-registry";
import { AdapterError, isLimitAbort } from "../errors";
import { presetOf } from "../preset";
import { systemPrompt, userPrompt } from "../tool-loop";
import type {
  AdapterCapabilities,
  AdapterEvent,
  AgentAdapter,
  AgentConfig,
  ConnectorConfig,
  McpServerConfig,
  RunContext,
  RunInput,
  RunResult,
} from "../types";

/** What a CLI's parser keeps between lines. */
export interface CliState {
  /** Latest assistant text. */
  text: string;
  /** The CLI's own final answer, when it reports one. */
  result: string | null;
  /** Cumulative usage as reported so far. */
  usage: TokenUsage;
  /** Cumulative cost when the CLI reports it (Claude Code does). */
  vendorCostUsd?: number;
  sessionId?: string;
  error?: string;
  /** Whether the CLI emitted its terminal event. */
  finished: boolean;
}

export interface CliSpec {
  key: string;
  /** Registry connector id. */
  connector: string;
  /** The model-API preset of the CLI's vendor: key checks, live model lists and prices go through it. */
  vendorPreset: string;
  /** Environment variables that receive the API key. */
  credentialEnv: string[];
  /** Environment that keeps the CLI quiet and unattended (telemetry, auto-update, colour). */
  env?: Record<string, string>;
  /** Hosts the CLI must reach from inside the sandbox (its vendor's API); everything else is denied. */
  egressHosts: string[];
  /** The sandbox image with this CLI installed. */
  image: string;
  /** argv for one headless run; the prompt goes in argv or on stdin. */
  argv(prompt: string, config: AgentConfig, input: RunInput): string[];
  promptVia: "arg" | "stdin";
  /** Files to write into the worktree before the run (MCP config, hook config). Paths relative to the worktree. */
  files?(input: RunInput, config: AgentConfig): Array<{ path: string; content: string }>;
  /** One parsed stdout JSON value → events; updates state. */
  parse(event: Record<string, unknown>, state: CliState): AdapterEvent[];
  /** Plain-text stdout lines, for CLIs without structured output (Aider) or with text warnings (Cursor). */
  parseText?(line: string, state: CliState): AdapterEvent[];
  /** Trust only diffs and checks, never the exit status (Antigravity headless issue 548). */
  exitStatusUntrusted?: boolean;
  /** The CLI reports its own cost, so no price table entry is needed. */
  reportsCost?: boolean;
  /**
   * The CLI reports neither tokens nor cost (billing happens on the vendor's own plan): the run is limited by time
   * only and its cost is recorded as unmetered (D-37).
   */
  unmetered?: boolean;
  /**
   * For CLIs whose key is not a model-API key (Cursor): how to check it and list models without a sandbox. By default
   * both go through the vendor preset's model API.
   */
  keyCheck?: "vendor" | "on-first-run";
  /**
   * How this CLI is given MCP servers (the Brio mailbox): extra argv, environment and files. CLIs without MCP support
   * leave it out and run without the mailbox.
   */
  mcp?(servers: McpServerConfig[]): {
    argv?: (argv: string[]) => string[];
    env?: Record<string, string>;
    files?: Array<{ path: string; content: string }>;
  };
}

/** Longest prompt passed as one argv element (Linux caps a single argument at 128 KiB). */
export const MAX_PROMPT_ARG = 100_000;
export const PROMPT_FILE = ".brio/prompt.md";

export const newCliState = (): CliState => ({ text: "", result: null, usage: ZERO_USAGE, finished: false });

/** Adds `next` to `prev` when a CLI reports per-turn usage; replaces when it reports cumulative totals. */
export function mergeUsage(prev: TokenUsage, next: TokenUsage, mode: "add" | "replace"): TokenUsage {
  return mode === "add" ? addUsage(prev, next) : next;
}

function summarise(text: string): string {
  const t = text.trim();
  const first = t.split(/\n\s*\n/)[0] ?? t;
  return first.length <= 600 ? first : `${first.slice(0, 597).trimEnd()}…`;
}

export function createCliAdapter(spec: CliSpec): AgentAdapter & { spec: CliSpec } {
  const vendor = () => {
    const preset = registry().preset(spec.vendorPreset);
    if (!preset?.baseUrl) throw new AdapterError("misconfigured", `no ${spec.vendorPreset} preset`);
    const family = ADAPTERS_BY_FAMILY[preset.family];
    if (!family) throw new AdapterError("misconfigured", `no adapter for ${preset.family}`);
    const config: ConnectorConfig = {
      registryKey: preset.connector,
      presetKey: spec.vendorPreset,
      preset,
      baseUrl: preset.baseUrl,
    };
    return { family, config };
  };

  return {
    key: spec.key,
    route: "cli",
    spec,

    capabilities(config: AgentConfig): AdapterCapabilities {
      return {
        taskTypes: registry().taskTypesOf(config.connector.registryKey),
        editsFiles: true,
        runsCode: true,
        browses: false,
        producesMedia: [],
        streaming: true,
        supportsMcpTools: true,
        supportsResume: false,
        runnerModes: ["cloud", "local"],
      };
    },

    // The key belongs to the CLI's vendor, so it is checked (for free) against that vendor's API.
    async healthCheck(_config, ctx) {
      if (spec.keyCheck === "on-first-run")
        return {
          ok: true,
          latencyMs: 0,
          detail: "not verifiable without a run: the key is checked when the first attempt starts",
        };
      const { family, config } = vendor();
      return family.healthCheck(config, ctx);
    },

    async listModels(_config, ctx) {
      if (spec.keyCheck === "on-first-run") return [];
      const { family, config } = vendor();
      return (await family.listModels?.(config, ctx)) ?? [];
    },

    async estimate(input, config) {
      const { family } = vendor();
      return family.estimate(input, config);
    },

    async run(input: RunInput, config: AgentConfig, outer: RunContext): Promise<RunResult> {
      const started = performance.now();
      const secret = outer.credential?.reveal() ?? "";
      const scrub = <T>(v: T): T =>
        secret.length >= 8 ? (JSON.parse(JSON.stringify(v).replaceAll(secret, "[redacted]")) as T) : v;
      const emit = (e: AdapterEvent) => outer.emit(scrub(e));
      const state = newCliState();
      let usd = 0;

      const finish = (status: RunResult["status"], error?: string): RunResult =>
        scrub({
          status,
          summary: summarise(state.result ?? state.text) || error || "",
          output: state.result ?? state.text,
          artifacts: [],
          usage: {
            usd: roundUsd(usd),
            tokensIn: state.usage.inputTokens + state.usage.cachedInputTokens + state.usage.cacheWriteTokens,
            tokensOut: state.usage.outputTokens,
            seconds: Math.round((performance.now() - started) / 100) / 10,
          },
          tokens: state.usage,
          ...(state.sessionId ? { vendorRunId: state.sessionId } : {}),
          ...(error ? { error } : {}),
        } as RunResult);

      if (!outer.sandbox.available) return finish("failed", "CLI agents run only inside a sandbox");
      if (!config.price && !spec.reportsCost && !spec.unmetered && !presetOf(config.connector).pricing.free)
        return finish("failed", `no price for ${config.model}: set one on the agent before running it`);

      const mcp = input.mcpServers.length && spec.mcp ? spec.mcp(input.mcpServers) : {};
      try {
        for (const f of [...(spec.files?.(input, config) ?? []), ...(mcp.files ?? [])])
          await outer.sandbox.writeFile(f.path, f.content);
      } catch (e) {
        return finish("failed", `could not prepare the worktree: ${(e as Error).message}`);
      }

      let prompt = `${systemPrompt(config)}\n\n${userPrompt(input)}`;
      if (spec.promptVia === "arg" && prompt.length > MAX_PROMPT_ARG) {
        // Too long for one argument: hand it over as a file (the runner keeps .brio/ out of the diff).
        try {
          await outer.sandbox.writeFile(PROMPT_FILE, prompt);
        } catch (e) {
          return finish("failed", `could not write the prompt: ${(e as Error).message}`);
        }
        prompt = `Your full task is in ${PROMPT_FILE}. Read it first and follow it exactly.`;
      }
      const env: Record<string, string> = { ...spec.env, ...mcp.env };
      if (secret) for (const name of spec.credentialEnv) env[name] = secret;
      let proc: ReturnType<RunContext["sandbox"]["spawn"]>;
      try {
        const argv = spec.argv(prompt, config, input);
        proc = outer.sandbox.spawn(mcp.argv ? mcp.argv(argv) : argv, {
          env,
          ...(spec.promptVia === "stdin" ? { stdin: prompt } : {}),
        });
      } catch (e) {
        return finish("failed", `could not start ${spec.key}: ${(e as Error).message}`);
      }

      let limitError: string | null = null;
      const textTail: string[] = [];
      const onAbort = () => void proc.kill();
      outer.signal.addEventListener("abort", onAbort, { once: true });
      try {
        for await (const line of proc.lines) {
          const trimmed = line.trim();
          let value: unknown;
          try {
            value = trimmed.startsWith("{") ? JSON.parse(trimmed) : undefined;
          } catch {
            value = undefined;
          }
          if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            for (const e of spec.parse(value as Record<string, unknown>, state)) emit(e);
          } else if (trimmed) {
            textTail.push(trimmed);
            if (textTail.length > 20) textTail.shift();
            for (const e of spec.parseText?.(trimmed, state) ?? []) emit(e);
          }

          const now = state.vendorCostUsd ?? (config.price ? costOf(state.usage, config.price) : 0);
          if (now > usd) {
            const delta = now - usd;
            usd = now;
            emit({
              kind: "cost",
              usd: roundUsd(delta),
              tokensIn:
                state.usage.inputTokens + state.usage.cachedInputTokens + state.usage.cacheWriteTokens,
              tokensOut: state.usage.outputTokens,
              usage: state.usage,
              model: config.model,
              priceSource: state.vendorCostUsd !== undefined ? "vendor" : "table",
            });
          }
          if (usd > input.limits.maxCostUsd && !limitError) {
            limitError = `cost $${roundUsd(usd)} passed the limit of $${input.limits.maxCostUsd}`;
            await proc.kill();
          }
        }
      } finally {
        outer.signal.removeEventListener("abort", onAbort);
      }
      const { code, stderr } = await proc.exit;

      if (limitError) return finish("limit_exceeded", limitError);
      if (outer.signal.aborted)
        return isLimitAbort(outer.signal)
          ? finish("limit_exceeded", (outer.signal.reason as Error).message)
          : finish("cancelled", "cancelled");
      if (state.error) return finish("failed", state.error);
      if (code !== 0 && !(spec.exitStatusUntrusted && state.finished))
        return finish(
          "failed",
          `${spec.key} exited with ${code}: ${stderr.trim().split("\n").slice(-5).join(" | ") || "no output"}`,
        );
      if (!state.finished && !state.text) return finish("failed", `${spec.key} produced no result`);
      return finish("completed");
    },
  };
}
