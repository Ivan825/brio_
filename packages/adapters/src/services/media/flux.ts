// Black Forest Labs FLUX (docs/vendors/media.md §3): the model is the path (POST /v1/{model}), every request is a job
// followed at the polling_url it returns, and the result's signed URL (minutes to live, on another host) is fetched
// without the key. Cost is reported in credits at a cent each.
import { AdapterError } from "../../errors";
import type { ProducedFile, RunInput } from "../../types";
import { createJobAdapter, type JobUpdate } from "../job";
import {
  closestRatio,
  download,
  durationOf,
  type MediaKind,
  mediaCapabilities,
  mediaKindOf,
  mediaPrompt,
  mediaShape,
  pickFormat,
} from "./common";

interface Job {
  id: string;
  pollingUrl: string;
  input: RunInput;
  kind: MediaKind;
  credits: number;
  files: ProducedFile[];
}

type Result = {
  id?: string;
  status?: string;
  result?: { sample?: string; samples?: string[] } | null;
  cost?: number;
  details?: unknown;
};

const RATIOS = ["21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16", "9:21"];
const DONE_BAD: Record<string, string> = {
  "Request Moderated": "the request was moderated",
  "Content Moderated": "the result was moderated",
  Error: "the generation failed",
  "Task not found": "the job was lost at the vendor",
  "No Card Generated": "no result was generated",
};

/** Width and height at about a megapixel for the aspect, multiples of 32 (for models that take only a size). */
function sizeFor(aspect: number): { width: number; height: number } {
  const h = Math.sqrt(1_048_576 / aspect);
  const r = (x: number) => Math.max(256, Math.round(x / 32) * 32);
  return { width: r(h * aspect), height: r(h) };
}

const videoResolution = (h: number) => (h > 1440 ? "uhd" : h > 1080 ? "qhd" : h > 720 ? "fhd" : "hd");

/** The request body for a model, from what the task's check wants. */
export function fluxBody(model: string, input: RunInput, kind: MediaKind): Record<string, unknown> {
  const shape = mediaShape(input);
  const prompt = mediaPrompt(input, kind);
  if (kind === "video")
    return {
      prompt,
      mode: "t2v",
      aspect_ratio: closestRatio(shape.aspect, ["16:9", "9:16", "1:1"]),
      duration: shape.durationS ? Math.round(Math.min(20, Math.max(5, shape.durationS))) : "auto",
      resolution: videoResolution(shape.height ?? 1080),
    };
  const exact = shape.width && shape.height ? { width: shape.width, height: shape.height } : null;
  const takesRatio = /flux-3|ultra|kontext/.test(model);
  return {
    prompt,
    ...(exact
      ? exact
      : shape.aspect
        ? takesRatio
          ? { aspect_ratio: closestRatio(shape.aspect, RATIOS) }
          : sizeFor(shape.aspect)
        : {}),
    ...(/flux-2|flux-pro|kontext|flux-dev/.test(model)
      ? { output_format: pickFormat(shape, ["png", "jpeg", "webp"] as const, "png") }
      : {}),
  };
}

export const flux = createJobAdapter<Job>({
  key: "flux",
  route: "api",
  capabilities: mediaCapabilities(["image", "video"]),
  estimateUsd: 0.1,
  pollMs: 1500,

  async start(input, config, api) {
    if (!/^[\w.-]+(\/[\w.-]+)?$/.test(config.model))
      throw new AdapterError("misconfigured", `not a FLUX model path: ${config.model}`);
    const kind = mediaKindOf(input, /video/.test(config.model) ? "video" : "image");
    if (kind === "audio") throw new AdapterError("bad_request", "FLUX makes images and video, not audio");
    const r = await api.json<{ id: string; polling_url?: string; cost?: number }>(
      "POST",
      `/v1/${config.model}`,
      fluxBody(config.model, input, kind),
      { retries: 0 },
    );
    return {
      id: r.id,
      pollingUrl: r.polling_url ?? `/v1/get_result?id=${encodeURIComponent(r.id)}`,
      input,
      kind,
      credits: r.cost ?? 0,
      files: [],
    };
  },

  idOf: (j) => j.id,

  async poll(job, config, api): Promise<JobUpdate<Job>> {
    const r = await api.json<Result>("GET", job.pollingUrl);
    const credits = r.cost ?? job.credits;
    const usage = { units: credits };
    const next = { ...job, credits };
    if (r.status && DONE_BAD[r.status])
      return { job: next, state: "failed", error: DONE_BAD[r.status], usage };
    if (r.status !== "Ready")
      return { job: next, state: "running", progress: r.status ? [r.status] : [], usage };
    const urls = [r.result?.sample, ...(r.result?.samples ?? [])].filter((u): u is string => Boolean(u));
    if (!urls.length)
      return { job: next, state: "failed", error: "the job finished without a result", usage };
    const files = await download(api, job.input, job.kind, [...new Set(urls)], {
      model: config.model,
      id: job.id,
    });
    const seconds =
      job.kind === "video" ? files.reduce((s, f) => s + (durationOf(f.bytes) ?? 0), 0) : undefined;
    return {
      job: { ...next, files },
      state: "done",
      usage,
      ...(seconds ? { progress: [`made ${seconds.toFixed(1)} s of video`] } : {}),
    };
  },

  async outputs(job) {
    return { text: `Made ${job.files.map((f) => f.path ?? f.name).join(", ")}.`, files: job.files };
  },
});
