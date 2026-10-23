// Kling (docs/vendors/media.md §6): the current API — the model in the path (/text-to-video/kling-4.0), a plain API
// key, every answer wrapped in {code, data} (code 0 is success even on HTTP 200), tasks followed at /tasks?task_ids=.
// Charges come back in billing[]; in US dollars they are metered as reported, otherwise by the seconds made.
import { AdapterError } from "../../errors";
import type { ProducedFile, RunInput } from "../../types";
import type { ServiceClient } from "../client";
import { createJobAdapter, type JobUpdate, type JobUsage } from "../job";
import { closestRatio, download, mediaCapabilities, mediaPrompt, mediaShape } from "./common";

interface Job {
  id: string;
  input: RunInput;
  files: ProducedFile[];
}

type Envelope<T> = { code?: number; message?: string; request_id?: string; data?: T };
type Task = {
  id?: string;
  status?: "submitted" | "processing" | "succeeded" | "failed";
  message?: string;
  outputs?: Array<{ type?: string; url?: string; duration?: string }>;
  billing?: Array<{ charge_type?: string; amount?: number | string; currency?: string }>;
};

async function call<T>(
  api: ServiceClient,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  query?: Record<string, string>,
) {
  const r = await api.json<Envelope<T>>(method, path, body, {
    ...(query ? { query } : {}),
    retries: method === "GET" ? 2 : 0,
  });
  if (r.code !== undefined && r.code !== 0)
    throw new AdapterError("bad_request", `Kling ${r.code}: ${r.message ?? "request failed"}`);
  return r.data as T;
}

export function klingBody(input: RunInput): Record<string, unknown> {
  const shape = mediaShape(input);
  return {
    prompt: mediaPrompt(input, "video", 2500),
    settings: {
      ...(shape.durationS ? { duration: Math.min(30, Math.max(1, Math.round(shape.durationS))) } : {}),
      resolution: (shape.height ?? 1080) > 720 ? "1080p" : "720p",
      aspect_ratio: closestRatio(shape.aspect, ["16:9", "9:16", "1:1", "21:9"]),
    },
    options: { watermark_info: { enabled: false } },
  };
}

/** What a finished task cost: US dollars when billed in cash, and the seconds it made either way. */
export function klingUsage(t: Task): JobUsage {
  const seconds = (t.outputs ?? [])
    .filter((o) => o.type === "video")
    .reduce((s, o) => s + (Number(o.duration) || 0), 0);
  const usd = (t.billing ?? [])
    .filter((b) => b.charge_type === "cash" && (b.currency ?? "").toUpperCase() === "USD")
    .reduce((s, b) => s + (Number(b.amount) || 0), 0);
  return { units: seconds, ...(usd > 0 ? { usd } : {}) };
}

export const kling = createJobAdapter<Job>({
  key: "kling",
  route: "api",
  capabilities: mediaCapabilities(["video"]),
  estimateUsd: 1.5,
  pollMs: 5000,

  async start(input, config, api) {
    if (!/^[\w.-]+$/.test(config.model))
      throw new AdapterError("misconfigured", `not a Kling model: ${config.model}`);
    if (input.taskType !== "media.video")
      throw new AdapterError("bad_request", "this Kling agent makes video");
    const capability =
      typeof config.options?.capability === "string" ? config.options.capability : "text-to-video";
    const d = await call<{ id?: string }>(api, "POST", `/${capability}/${config.model}`, klingBody(input));
    if (!d?.id) throw new AdapterError("bad_request", "Kling did not return a task id");
    return { id: d.id, input, files: [] };
  },

  idOf: (j) => j.id,

  async poll(job, config, api): Promise<JobUpdate<Job>> {
    const d = await call<{ result?: Task[] }>(api, "GET", "/tasks", undefined, { task_ids: job.id });
    const t = (d?.result ?? []).find((x) => x.id === job.id) ?? d?.result?.[0];
    if (!t) return { job, state: "running" };
    if (t.status === "failed")
      return { job, state: "failed", error: t.message || "the task failed", usage: klingUsage(t) };
    if (t.status !== "succeeded") return { job, state: "running", progress: [t.status ?? "submitted"] };
    const urls = (t.outputs ?? []).filter((o) => o.type === "video" && o.url).map((o) => o.url as string);
    const files = await download(api, job.input, "video", urls, { model: config.model, task: job.id });
    if (!files.length) return { job, state: "failed", error: "the task finished without a video" };
    return { job: { ...job, files }, state: "done", usage: klingUsage(t) };
  },

  async outputs(job) {
    return { text: `Made ${job.files.map((f) => f.path ?? f.name).join(", ")}.`, files: job.files };
  },
});
