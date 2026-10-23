// The async-job pattern every hosted agent and media model shares (ADAPTER_SPEC §2.4, §2.8): start a job, follow it
// until it ends, answer what it asks along the way, and collect what it made. A vendor supplies those steps; this
// does the rest the same way for all of them: limits, cancellation, cost events, questions and approvals routed to a
// person (no answer is no approval), a patch applied to the worktree, and produced files handed to the runner.
import { AdapterError, isLimitAbort, LimitExceeded } from "../errors";
import type {
  AdapterCapabilities,
  AgentAdapter,
  AgentConfig,
  ConnectorConfig,
  HealthStatus,
  ModelInfo,
  ProducedFile,
  Route,
  RunContext,
  RunInput,
  RunResult,
} from "../types";
import { ServiceClient } from "./client";

/** What a vendor said since the last poll. */
export interface JobUpdate<J> {
  /** The job's state, possibly updated (cursors, new ids). */
  job: J;
  state: "running" | "needs_input" | "done" | "failed" | "cancelled";
  messages?: string[];
  progress?: string[];
  /** Something the job waits for: a question for a person, or an approval of an action. */
  question?: JobQuestion;
  error?: string;
  /** Cumulative usage so far, in the service's billing unit. */
  usage?: JobUsage;
}

export interface JobQuestion {
  id: string;
  kind: "message" | "approval";
  text: string;
}

export interface JobUsage {
  /** USD the vendor reported (Claude's list cost, a media API's charge). */
  usd?: number;
  tokensIn?: number;
  tokensOut?: number;
  cachedTokensIn?: number;
  /** Units billed in the service's own unit (ACUs, credits, images, seconds, characters). */
  units?: number;
}

export interface JobOutputs {
  text: string;
  files?: ProducedFile[];
  /** A unified diff to apply to the task's worktree (Jules's change sets). */
  patch?: string;
  /** Links the job produced: pull requests, hosted pages. */
  urls?: string[];
}

export interface JobVendor<J> {
  key: string;
  route: Route;
  capabilities(config: AgentConfig): AdapterCapabilities;
  /** Starts the job. */
  start(input: RunInput, config: AgentConfig, api: ServiceClient, ctx: RunContext): Promise<J>;
  /** What changed. */
  poll(job: J, config: AgentConfig, api: ServiceClient, ctx: RunContext): Promise<JobUpdate<J>>;
  /** Answers a question or an approval. Without it, questions fail the run. */
  answer?(
    job: J,
    q: JobQuestion,
    reply: { text: string; approve: boolean },
    api: ServiceClient,
    ctx: RunContext,
  ): Promise<J>;
  /** Stops the job at the vendor (best effort). */
  cancel?(job: J, api: ServiceClient, ctx: RunContext): Promise<void>;
  /** What it made, once done. */
  outputs(job: J, config: AgentConfig, api: ServiceClient, ctx: RunContext): Promise<JobOutputs>;
  /** The vendor's id for the run (shown and kept as the transcript reference). */
  idOf(job: J): string;
  listModels?(config: ConnectorConfig, api: ServiceClient): Promise<ModelInfo[]>;
  /** A rough cost per run before history, for the router. */
  estimateUsd?: number;
  /** How often to poll (ms). */
  pollMs?: number;
}

/** How long a person has to answer a hosted agent's question or approval before it is treated as a no. */
export const QUESTION_WAIT_MS = 10 * 60_000;

const YES = /^\s*(y|yes|approve|approved|allow|ok|okay|go|go ahead|sure)\b/i;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/** The patch a job produced, applied in the sandbox's worktree (git apply). */
async function applyPatch(patch: string, ctx: RunContext): Promise<string | null> {
  if (!ctx.sandbox.available) return "the task has no worktree for the job's changes";
  await ctx.sandbox.writeFile(".brio/job.patch", patch);
  const r = await ctx.sandbox.exec("git apply --whitespace=nowarn --recount .brio/job.patch", {
    timeoutMs: 60_000,
  });
  return r.exitCode === 0 ? null : `the job's changes did not apply: ${(r.stderr || r.stdout).slice(-400)}`;
}

export function createJobAdapter<J>(v: JobVendor<J>): AgentAdapter {
  return {
    key: v.key,
    route: v.route,
    capabilities: (config) => v.capabilities(config),

    async healthCheck(config, ctx): Promise<HealthStatus> {
      return new ServiceClient(config, ctx).check();
    },

    ...(v.listModels
      ? {
          listModels: (config: ConnectorConfig, ctx: Pick<RunContext, "credential" | "fetch">) =>
            (v.listModels as NonNullable<typeof v.listModels>)(config, new ServiceClient(config, ctx)),
        }
      : {}),

    async estimate(input: RunInput) {
      return { usd: v.estimateUsd ?? 0.5, minutes: Math.min(input.limits.maxMinutes, 15) };
    },

    async run(input, config, ctx): Promise<RunResult> {
      const started = performance.now();
      const api = new ServiceClient(config.connector, {
        credential: ctx.credential,
        fetch: ctx.fetch,
        signal: ctx.signal,
      });
      const usage = { usd: 0, tokensIn: 0, tokensOut: 0 };
      const tokens = {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      };
      const messages: string[] = [];
      const result = (status: RunResult["status"], extra: Partial<RunResult> = {}): RunResult => ({
        status,
        summary: messages.at(-1)?.slice(0, 600) ?? "",
        output: messages.join("\n\n"),
        artifacts: [],
        usage: { ...usage, seconds: Math.round((performance.now() - started) / 1000) },
        tokens,
        ...extra,
      });

      /** Turns the vendor's cumulative usage into cost events (only the increase is new). */
      const meter = (u: JobUsage | undefined) => {
        if (!u) return;
        let usd = u.usd;
        if (usd === undefined && u.units !== undefined && config.unitPrice)
          usd = u.units * config.unitPrice.usd;
        if (usd === undefined && config.price && (u.tokensIn !== undefined || u.tokensOut !== undefined)) {
          const p = config.price;
          usd =
            (((u.tokensIn ?? 0) - (u.cachedTokensIn ?? 0)) * p.inputPerM +
              (u.cachedTokensIn ?? 0) * (p.cachedInputPerM ?? p.inputPerM) +
              (u.tokensOut ?? 0) * p.outputPerM) /
            1e6;
        }
        const tokensIn = u.tokensIn ?? usage.tokensIn;
        const tokensOut = u.tokensOut ?? usage.tokensOut;
        const delta = usd === undefined ? 0 : Math.max(0, usd - usage.usd);
        if (delta > 0 || tokensIn !== usage.tokensIn || tokensOut !== usage.tokensOut)
          ctx.emit({
            kind: "cost",
            usd: delta,
            tokensIn: tokensIn - usage.tokensIn,
            tokensOut: tokensOut - usage.tokensOut,
            model: config.model,
            priceSource: u.usd !== undefined ? "vendor" : "table",
          });
        if (usd !== undefined) usage.usd = Math.max(usage.usd, usd);
        usage.tokensIn = tokensIn;
        usage.tokensOut = tokensOut;
        tokens.inputTokens = tokensIn;
        tokens.outputTokens = tokensOut;
        tokens.cachedInputTokens = u.cachedTokensIn ?? tokens.cachedInputTokens;
        if (usage.usd > input.limits.maxCostUsd)
          throw new LimitExceeded(
            `spent $${usage.usd.toFixed(2)}, over the $${input.limits.maxCostUsd} limit`,
          );
      };

      let job: J;
      try {
        job = await v.start(input, config, api, ctx);
      } catch (e) {
        const err = e instanceof AdapterError ? e : new AdapterError("network", (e as Error).message);
        return result(ctx.signal.aborted ? "cancelled" : "failed", { error: err.message });
      }
      const id = v.idOf(job);
      ctx.emit({ kind: "progress", note: `started ${id}` });

      const declined = new Set<string>();
      const pollMs = Number(config.options?.pollMs ?? v.pollMs ?? 3000);
      const stop = async (status: RunResult["status"], error?: string) => {
        await v.cancel?.(job, api, ctx).catch(() => {});
        return result(status, { vendorRunId: id, ...(error ? { error } : {}) });
      };

      try {
        for (;;) {
          if (ctx.signal.aborted)
            return await stop(
              isLimitAbort(ctx.signal) ? "limit_exceeded" : "cancelled",
              (ctx.signal.reason as Error | undefined)?.message,
            );
          const u = await v.poll(job, config, api, ctx);
          job = u.job;
          for (const m of u.messages ?? []) {
            messages.push(m);
            ctx.emit({ kind: "message", role: "assistant", text: m });
          }
          for (const p of u.progress ?? []) ctx.emit({ kind: "progress", note: p });
          meter(u.usage);

          if (u.state === "failed")
            return result("failed", { vendorRunId: id, error: u.error ?? "the job failed" });
          if (u.state === "cancelled")
            return result("cancelled", { vendorRunId: id, error: u.error ?? "the job was cancelled" });
          if (u.state === "needs_input" && u.question) {
            const q = u.question;
            // A question that comes back after it was declined (or went unanswered) ends the run: asking again would
            // only loop.
            if (declined.has(q.id)) return await stop("failed", `declined: ${q.text.slice(0, 300)}`);
            if (!v.answer || !ctx.tools?.mailbox)
              return await stop(
                "failed",
                `the job needs input nobody can give here: ${q.text.slice(0, 300)}`,
              );
            ctx.emit({ kind: "needs_input", question: q.text });
            const asked =
              q.kind === "approval"
                ? `${v.key} asks for approval: ${q.text}\nReply yes to approve; anything else (or no answer) declines.`
                : q.text;
            const reply = await ctx.tools.mailbox.askUser(asked, { waitMs: QUESTION_WAIT_MS });
            const approve = reply !== null && YES.test(reply);
            if (!approve && q.kind === "approval") declined.add(q.id);
            if (q.kind === "approval" || reply !== null)
              job = await v.answer(job, q, { text: reply ?? "No answer; declined.", approve }, api, ctx);
            else
              return await stop(
                "failed",
                `nobody answered the job's question in time: ${q.text.slice(0, 300)}`,
              );
            continue;
          }
          if (u.state === "done") {
            meter(u.usage);
            const out = await v.outputs(job, config, api, ctx);
            if (out.text && !messages.includes(out.text)) {
              messages.push(out.text);
              ctx.emit({ kind: "message", role: "assistant", text: out.text });
            }
            let error: string | null = null;
            if (out.patch) error = await applyPatch(out.patch, ctx);
            for (const f of out.files ?? [])
              if (f.path) ctx.emit({ kind: "file_edit", path: f.path, op: "create" });
            return result(error ? "failed" : "completed", {
              vendorRunId: id,
              files: out.files ?? [],
              artifacts: (out.urls ?? []).map((url) => ({ kind: "url", ref: url })),
              ...(error ? { error } : {}),
            });
          }
          await sleep(pollMs, ctx.signal);
        }
      } catch (e) {
        if (e instanceof LimitExceeded) return await stop("limit_exceeded", e.message);
        if (ctx.signal.aborted) return await stop(isLimitAbort(ctx.signal) ? "limit_exceeded" : "cancelled");
        const msg = e instanceof AdapterError ? e.message : (e as Error).message;
        return await stop("failed", msg);
      }
    },
  };
}
