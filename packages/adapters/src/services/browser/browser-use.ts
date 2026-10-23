// Browser Use Cloud v4 (docs/vendors/research-browser.md §12): a run in Browser Use's own cloud browser, its cost
// capped at the attempt's remaining limit (maxCostUsd), its status polled cheaply, then read once; the run reports its
// own cost in dollars. Site credentials are never given to it: the task says to stop and report a sign-in instead.
import { AdapterError } from "../../errors";
import type { AdapterCapabilities, RunInput } from "../../types";
import { createJobAdapter, type JobUpdate } from "../job";

interface Job {
  id: string;
  summary: Summary | null;
}

type Status = "queued" | "dispatching" | "running" | "completed" | "failed" | "cancelled";
type Summary = {
  id?: string;
  status?: Status;
  result?: unknown;
  output?: unknown;
  error?: string | null;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCostUsd?: number | string;
};

export const browserCapabilities =
  (o: Partial<AdapterCapabilities> = {}) =>
  (): AdapterCapabilities => ({
    taskTypes: [],
    editsFiles: false,
    runsCode: false,
    browses: true,
    producesMedia: [],
    streaming: false,
    supportsMcpTools: false,
    supportsResume: false,
    runnerModes: ["cloud"],
    ...o,
  });

/** The rule every browser agent gets: no secrets typed, nothing irreversible without a person. */
export const BROWSER_RULES = [
  "Never type passwords, one-time codes or payment details, and never sign in: if a page needs that, stop and say so.",
  "Do not buy, send, publish, delete or submit anything irreversible unless the task explicitly says to.",
  "Stay on the sites the task names.",
].join(" ");

export function browserTask(input: RunInput, rolePrompt = ""): string {
  return [rolePrompt, input.instructions, `Rules: ${BROWSER_RULES}`].filter(Boolean).join("\n\n");
}

const text = (v: unknown) =>
  v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v, null, 2);

export const browserUse = createJobAdapter<Job>({
  key: "browser-use",
  route: "hosted",
  capabilities: browserCapabilities(),
  estimateUsd: 0.5,
  pollMs: 2000,

  async start(input, config, api) {
    const r = await api.json<{ id?: string; status?: Status }>(
      "POST",
      "/v4/runs",
      {
        task: browserTask(input, config.rolePrompt),
        ...(config.model && config.model !== "default" ? { model: config.model } : {}),
        maxCostUsd: input.limits.maxCostUsd,
        ...(config.options?.outputSchema ? { outputSchema: config.options.outputSchema } : {}),
      },
      { retries: 0 },
    );
    if (!r.id) throw new AdapterError("bad_request", "Browser Use did not return a run id");
    return { id: r.id, summary: null };
  },

  idOf: (j) => j.id,

  async poll(job, _config, api): Promise<JobUpdate<Job>> {
    const s = await api.json<{ status?: Status }>("GET", `/v4/runs/${job.id}/status`);
    if (!s.status || !["completed", "failed", "cancelled"].includes(s.status))
      return { job, state: "running", progress: [s.status ?? "queued"] };
    const summary = await api.json<Summary>("GET", `/v4/runs/${job.id}`);
    const usage = {
      usd: Number(summary.totalCostUsd ?? 0),
      tokensIn: summary.totalInputTokens ?? 0,
      tokensOut: summary.totalOutputTokens ?? 0,
    };
    const next = { ...job, summary };
    if (s.status === "completed") return { job: next, state: "done", usage };
    return {
      job: next,
      state: s.status === "cancelled" ? "cancelled" : "failed",
      error: summary.error ?? `the run ${s.status}`,
      usage,
    };
  },

  async cancel(job, api) {
    await api.json("POST", `/v4/runs/${job.id}/cancel`, {}, { retries: 0 });
  },

  async outputs(job) {
    const s = job.summary ?? {};
    const out = text(s.output) || text(s.result);
    return { text: out || "The run finished without a written result." };
  },
});
