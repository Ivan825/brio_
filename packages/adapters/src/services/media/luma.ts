// Luma Agents API (docs/vendors/media.md §5): a generation (ray-* video, uni-* images) followed at
// /v1/generations/{id}; presigned results live an hour. Luma reports no cost, so runs are metered per generation at
// the agent's (or the registry's) rate.
import { AdapterError } from "../../errors";
import type { ProducedFile, RunInput } from "../../types";
import { createJobAdapter, type JobUpdate } from "../job";
import {
  closestRatio,
  download,
  type MediaKind,
  mediaCapabilities,
  mediaKindOf,
  mediaPrompt,
  mediaShape,
  pickFormat,
} from "./common";

interface Job {
  id: string;
  input: RunInput;
  kind: MediaKind;
  files: ProducedFile[];
}

type Generation = {
  id?: string;
  state?: "queued" | "processing" | "completed" | "failed";
  failure_code?: string;
  failure_reason?: string;
  output?: Array<{ type?: string; url?: string }>;
};

const RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];

export function lumaBody(model: string, input: RunInput, kind: MediaKind): Record<string, unknown> {
  const shape = mediaShape(input);
  const base = { model, prompt: mediaPrompt(input, kind), aspect_ratio: closestRatio(shape.aspect, RATIOS) };
  if (kind === "image")
    return { ...base, type: "image", output_format: pickFormat(shape, ["png", "jpeg"] as const, "png") };
  const h = shape.height ?? 720;
  return {
    ...base,
    type: "video",
    video: {
      resolution: h > 720 ? "1080p" : h > 540 ? "720p" : "540p",
      duration: (shape.durationS ?? 5) > 7.5 ? "10s" : "5s",
    },
  };
}

export const luma = createJobAdapter<Job>({
  key: "luma",
  route: "api",
  capabilities: mediaCapabilities(["image", "video"]),
  estimateUsd: 0.5,
  pollMs: 2000,

  async start(input, config, api) {
    const kind = mediaKindOf(input, /^uni/.test(config.model) ? "image" : "video");
    if (kind === "audio") throw new AdapterError("bad_request", "Luma makes images and video, not audio");
    const g = await api.json<Generation>("POST", "/generations", lumaBody(config.model, input, kind), {
      retries: 0,
    });
    if (!g.id) throw new AdapterError("bad_request", "Luma did not return a generation id");
    return { id: g.id, input, kind, files: [] };
  },

  idOf: (j) => j.id,

  async poll(job, config, api): Promise<JobUpdate<Job>> {
    const g = await api.json<Generation>("GET", `/generations/${job.id}`);
    if (g.state === "failed")
      return {
        job,
        state: "failed",
        error: [g.failure_code, g.failure_reason].filter(Boolean).join(": ") || "the generation failed",
      };
    if (g.state !== "completed") return { job, state: "running", progress: [g.state ?? "queued"] };
    const urls = (g.output ?? [])
      .filter((o) => o.url && (!o.type || o.type === job.kind))
      .map((o) => o.url as string);
    const files = await download(api, job.input, job.kind, urls, { model: config.model, generation: job.id });
    if (!files.length) return { job, state: "failed", error: "the generation finished without output" };
    return { job: { ...job, files }, state: "done", usage: { units: 1 } };
  },

  async outputs(job) {
    return { text: `Made ${job.files.map((f) => f.path ?? f.name).join(", ")}.`, files: job.files };
  },
});
