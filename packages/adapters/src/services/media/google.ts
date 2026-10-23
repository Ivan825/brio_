// Gemini media through the Interactions API (docs/vendors/media.md §2): Omni video and Nano Banana images. One POST
// returns the finished interaction; videos are asked for by URI (they pass 4 MB), and a URI's file is followed in the
// Files API until it is ACTIVE before it is downloaded with the key. Veo and Imagen are gone from this API.
import { AdapterError } from "../../errors";
import type { ProducedFile, RunInput } from "../../types";
import { createJobAdapter, type JobUpdate } from "../job";
import {
  b64,
  closestRatio,
  durationOf,
  type MediaKind,
  mediaCapabilities,
  mediaFile,
  mediaKindOf,
  mediaPrompt,
  mediaShape,
} from "./common";

type Content = { type?: string; mime_type?: string; data?: string; uri?: string; text?: string };
type Interaction = {
  id?: string;
  status?: string;
  steps?: Array<{ type?: string; content?: Content[] }>;
  error?: { message?: string };
};

interface Job {
  id: string;
  input: RunInput;
  kind: MediaKind;
  inline: Array<{ mime: string; data: string }>;
  /** Files still being written: their id in the Files API and download URI. */
  pending: Array<{ file: string; uri: string; mime: string; state?: string }>;
  text: string;
  files: ProducedFile[];
}

const VIDEO_RATIOS = ["16:9", "9:16"];
const IMAGE_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

function imageSize(w = 0, h = 0): string {
  const side = Math.max(w, h);
  return side > 2048 ? "4K" : side > 1024 ? "2K" : "1K";
}

function resolution(h = 0): string {
  return h > 1080 ? "4k" : h > 720 ? "1080p" : h > 0 && h <= 360 ? "360p" : "720p";
}

export const googleMedia = createJobAdapter<Job>({
  key: "google-media",
  route: "api",
  capabilities: mediaCapabilities(["image", "video"]),
  estimateUsd: 0.8,
  pollMs: 3000,

  async start(input, config, api) {
    const kind = mediaKindOf(input, /omni/.test(config.model) ? "video" : "image");
    if (kind === "audio")
      throw new AdapterError("bad_request", "Gemini media makes images and video, not audio");
    const shape = mediaShape(input);
    const response_format =
      kind === "video"
        ? {
            type: "video",
            aspect_ratio: closestRatio(shape.aspect, VIDEO_RATIOS),
            resolution: resolution(shape.height),
            delivery: "uri",
          }
        : {
            type: "image",
            aspect_ratio: closestRatio(shape.aspect, IMAGE_RATIOS),
            image_size: imageSize(shape.width, shape.height),
          };
    const r = await api.json<Interaction>(
      "POST",
      "/interactions",
      { model: config.model, input: mediaPrompt(input, kind), response_format, store: false },
      { retries: 0, timeoutMs: 15 * 60_000 },
    );
    if (r.status === "failed")
      throw new AdapterError("bad_request", r.error?.message ?? "the generation failed");
    const content = (r.steps ?? []).filter((s) => s.type === "model_output").flatMap((s) => s.content ?? []);
    const media = content.filter((c) => c.type === kind);
    if (!media.length)
      throw new AdapterError(
        "bad_request",
        `Gemini returned no ${kind}: ${
          content
            .map((c) => c.text ?? "")
            .join(" ")
            .slice(0, 300) || "empty answer"
        }`,
      );
    return {
      id: r.id ?? `interaction-${Date.now()}`,
      input,
      kind,
      files: [],
      inline: media.filter((c) => c.data).map((c) => ({ mime: c.mime_type ?? "", data: c.data as string })),
      pending: media
        .filter((c) => !c.data && c.uri)
        .map((c) => ({
          file: /\/files\/([^:/?]+)/.exec(c.uri as string)?.[1] ?? "",
          uri: c.uri as string,
          mime: c.mime_type ?? "",
        })),
      text: content
        .map((c) => c.text ?? "")
        .filter(Boolean)
        .join("\n"),
    };
  },

  idOf: (j) => j.id,

  async poll(job, config, api): Promise<JobUpdate<Job>> {
    const pending = [];
    for (const p of job.pending) {
      if (!p.file || p.state === "ACTIVE") {
        pending.push(p);
        continue;
      }
      const f = await api.json<{ state?: string; error?: { message?: string } }>("GET", `/files/${p.file}`);
      if (f.state === "FAILED")
        return { job, state: "failed", error: f.error?.message ?? "the generated file failed to process" };
      pending.push({ ...p, state: f.state ?? "ACTIVE" });
    }
    if (!pending.every((p) => !p.file || p.state === "ACTIVE"))
      return { job: { ...job, pending }, state: "running", progress: ["the video is processing"] };
    // Everything is ready: collect it now (URIs expire), so the run is metered on what it made.
    const meta = { model: config.model, interaction: job.id };
    const files: ProducedFile[] = job.inline.map((x, i) =>
      mediaFile(job.input, job.kind, x.mime, b64(x.data), meta, i),
    );
    for (const p of pending) {
      const r = await api.bytes(p.uri, { maxBytes: 500 * 1024 * 1024 });
      files.push(mediaFile(job.input, job.kind, p.mime || r.contentType, r.bytes, meta, files.length));
    }
    const units =
      job.kind === "video" ? files.reduce((s, f) => s + (durationOf(f.bytes) ?? 0), 0) : files.length;
    return { job: { ...job, pending: [], files }, state: "done", usage: { units } };
  },

  async outputs(job) {
    return { text: job.text, files: job.files };
  },
});
