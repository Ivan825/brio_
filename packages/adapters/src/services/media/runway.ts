// Runway (docs/vendors/media.md §4): text_to_video or text_to_image as a task, followed at /v1/tasks/{id} (THROTTLED
// is a queue, not an error), cancelled with DELETE, and charged in credits at a cent each. Ratios and durations are
// per model: the defaults are gen4.5's; an agent may list its model's own in options.ratios and options.durations.
import { AdapterError } from "../../errors";
import type { AgentConfig, ProducedFile, RunInput } from "../../types";
import { createJobAdapter, type JobUpdate } from "../job";
import {
  closest,
  closestRatio,
  download,
  type MediaKind,
  mediaCapabilities,
  mediaKindOf,
  mediaPrompt,
  mediaShape,
} from "./common";

interface Job {
  id: string;
  input: RunInput;
  kind: MediaKind;
  files: ProducedFile[];
}

type Task = {
  id?: string;
  status?: "PENDING" | "THROTTLED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  progress?: number;
  output?: string[];
  failure?: string;
  failureCode?: string;
  cost?: { credits?: number };
  estimatedCost?: { credits?: number };
};

const VIDEO_RATIOS = ["1280:720", "720:1280"];
const IMAGE_RATIOS = ["1920:1080", "1080:1920", "1024:1024", "1280:720", "720:1280"];
const VIDEO_DURATIONS = [2, 3, 4, 5, 6, 7, 8, 9, 10];

const list = <T>(v: unknown, fallback: T[]): T[] => (Array.isArray(v) && v.length ? (v as T[]) : fallback);

export function runwayRequest(config: AgentConfig, input: RunInput, kind: MediaKind) {
  const shape = mediaShape(input);
  const promptText = mediaPrompt(input, kind, 1000);
  if (kind === "video")
    return {
      path: "/v1/text_to_video",
      body: {
        model: config.model,
        promptText,
        ratio: closestRatio(shape.aspect, list(config.options?.ratios, VIDEO_RATIOS)),
        duration: closest(shape.durationS ?? 5, list(config.options?.durations, VIDEO_DURATIONS)),
      },
    };
  return {
    path: "/v1/text_to_image",
    body: {
      model: config.model,
      promptText,
      ratio: closestRatio(shape.aspect, list(config.options?.ratios, IMAGE_RATIOS)),
    },
  };
}

export const runway = createJobAdapter<Job>({
  key: "runway",
  route: "api",
  capabilities: mediaCapabilities(["image", "video"]),
  estimateUsd: 0.6,
  pollMs: 5000,

  async start(input, config, api) {
    const kind = mediaKindOf(input, /image|banana/.test(config.model) ? "image" : "video");
    if (kind === "audio") throw new AdapterError("bad_request", "this Runway agent makes images and video");
    const req = runwayRequest(config, input, kind);
    const r = await api.json<{ id: string }>("POST", req.path, req.body, { retries: 0 });
    return { id: r.id, input, kind, files: [] };
  },

  idOf: (j) => j.id,

  async poll(job, config, api): Promise<JobUpdate<Job>> {
    const t = await api.json<Task>("GET", `/v1/tasks/${job.id}`);
    const credits = t.cost?.credits;
    const usage = credits !== undefined ? { units: credits } : undefined;
    switch (t.status) {
      case "SUCCEEDED": {
        const files = await download(api, job.input, job.kind, t.output ?? [], {
          model: config.model,
          task: job.id,
        });
        if (!files.length) return { job, state: "failed", error: "the task finished without output" };
        return { job: { ...job, files }, state: "done", ...(usage ? { usage } : {}) };
      }
      case "FAILED":
        // Moderation fails the task and is still charged.
        return {
          job,
          state: "failed",
          error: [t.failureCode, t.failure].filter(Boolean).join(": ") || "the task failed",
          ...(usage ? { usage } : {}),
        };
      case "CANCELLED":
        return { job, state: "cancelled", ...(usage ? { usage } : {}) };
      default:
        return {
          job,
          state: "running",
          progress: [
            t.status === "THROTTLED"
              ? "queued at Runway"
              : t.progress !== undefined
                ? `${Math.round(t.progress * 100)}%`
                : (t.status ?? "pending").toLowerCase(),
          ],
        };
    }
  },

  async cancel(job, api) {
    await api.json("DELETE", `/v1/tasks/${job.id}`, undefined, { retries: 0 });
  },

  async outputs(job) {
    return { text: `Made ${job.files.map((f) => f.path ?? f.name).join(", ")}.`, files: job.files };
  },
});
