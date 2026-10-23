// What every media model gets from a task (ADAPTER_SPEC §2.8): a prompt from the contract (objective, constraints and
// the output's description), the shape the task's media_spec check asks for (size, aspect ratio, duration, formats),
// and where the result belongs in the repository (the contract output's path). Results are downloaded at once (vendor
// URLs expire) and handed to the runner as produced files; it places them in the worktree, where the media_spec check
// reads them.
import { probeMedia } from "@brio/core";
import { AdapterError } from "../../errors";
import type {
  AdapterCapabilities,
  AgentConfig,
  ProducedFile,
  Route,
  RunContext,
  RunInput,
} from "../../types";
import type { ServiceClient } from "../client";
import { createJobAdapter, type JobUsage } from "../job";

export type MediaKind = "image" | "video" | "audio";

export interface MediaShape {
  width?: number;
  height?: number;
  /** Width ÷ height. */
  aspect?: number;
  durationS?: number;
  formats: string[];
}

/** The kind of result a task asks for, from its type (media.voice is audio). */
export function mediaKindOf(input: RunInput, fallback: MediaKind): MediaKind {
  if (input.taskType === "media.video") return "video";
  if (input.taskType === "media.image") return "image";
  if (input.taskType === "media.voice" || input.taskType === "media.music") return "audio";
  return fallback;
}

export function mediaPrompt(input: RunInput, kind: MediaKind, max = 4000): string {
  const c = input.contract;
  const out = c.outputs.find((o) => o.kind === kind)?.description;
  return [c.objective, out, ...c.constraints]
    .filter(Boolean)
    .map((s) => (s as string).trim().replace(/\.$/, ""))
    .join(". ")
    .slice(0, max);
}

/** The shape the task's media_spec check will hold the result to. */
export function mediaShape(input: RunInput): MediaShape {
  const spec = input.contract.acceptance.find((a) => a.kind === "media_spec")?.params ?? {};
  const n = (k: string) => (typeof spec[k] === "number" ? (spec[k] as number) : undefined);
  const width = n("width") ?? n("minWidth");
  const height = n("height") ?? n("minHeight");
  const aspect = n("aspect") ?? (width && height ? width / height : undefined);
  const durationS = n("maxDurationS") ?? n("minDurationS");
  return {
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(aspect ? { aspect } : {}),
    ...(durationS ? { durationS } : {}),
    formats: Array.isArray(spec.formats) ? (spec.formats as string[]) : [],
  };
}

/** The first format the check accepts that the vendor can make, or the vendor's default. */
export function pickFormat<T extends string>(shape: MediaShape, offered: readonly T[], fallback: T): T {
  const alias = (f: string) => (f === "jpg" ? "jpeg" : f);
  return (shape.formats.map(alias).find((f) => (offered as readonly string[]).includes(f)) as T) ?? fallback;
}

/** Where the contract says a result of this kind goes (an output path), if anywhere. */
export function outputPath(input: RunInput, kind: MediaKind): string | undefined {
  const outs = input.contract.outputs.filter((o) => o.path);
  return (outs.find((o) => o.kind === kind) ?? outs.find((o) => o.kind === "file"))?.path;
}

const ratioValue = (r: string) => {
  const [w, h] = r.split(/[:x]/).map(Number);
  return (w || 1) / (h || 1);
};

/** The supported ratio ("16:9", "1280:720") closest to the wanted aspect, or the first. */
export function closestRatio(aspect: number | undefined, ratios: readonly string[]): string {
  if (!aspect) return ratios[0] as string;
  const off = (r: string) => Math.abs(Math.log(ratioValue(r) / aspect));
  return [...ratios].sort((a, b) => off(a) - off(b))[0] as string;
}

/** The nearest allowed number. */
export const closest = (x: number, allowed: readonly number[]) =>
  [...allowed].sort((a, b) => Math.abs(a - x) - Math.abs(b - x))[0] as number;

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
};

/** The content type from the bytes themselves when the vendor's header is generic (presigned downloads often are). */
function sniff(contentType: string, bytes: Uint8Array): string {
  const type = contentType.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
  if (EXT[type]) return type;
  const f = probeMedia(bytes).format;
  const byFormat: Record<string, string> = {
    png: "image/png",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    mp4: "video/mp4",
    mp3: "audio/mpeg",
    wav: "audio/wav",
  };
  return byFormat[f] ?? type;
}

/** A generated file, named and placed where the contract wants it (a second result gets a numbered name). */
export function mediaFile(
  input: RunInput,
  kind: MediaKind,
  contentType: string,
  bytes: Uint8Array,
  meta: Record<string, unknown>,
  index = 0,
): ProducedFile {
  const type = sniff(contentType, bytes);
  const ext = EXT[type] ?? type.split("/")[1] ?? "bin";
  const path = outputPath(input, kind);
  const at = path && index > 0 ? path.replace(/(\.[^./]+)?$/, `-${index + 1}$1`) : path;
  return {
    kind,
    name: at?.split("/").pop() ?? `${kind}-${index + 1}.${ext}`,
    contentType: type,
    bytes,
    ...(at ? { path: at } : {}),
    meta,
  };
}

/** Seconds of audio or video in a file, read from its headers. */
export const durationOf = (bytes: Uint8Array) => probeMedia(bytes).durationS;

export const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

/** Downloads every result URL now (they expire), without the service's credentials. */
export async function download(
  api: ServiceClient,
  input: RunInput,
  kind: MediaKind,
  urls: string[],
  meta: Record<string, unknown>,
): Promise<ProducedFile[]> {
  const files: ProducedFile[] = [];
  for (const [i, url] of urls.entries()) {
    const r = await api.bytes(url, {
      auth: false,
      maxBytes: kind === "video" ? 500 * 1024 * 1024 : undefined,
    });
    files.push(mediaFile(input, kind, r.contentType, r.bytes, meta, i));
  }
  return files;
}

/**
 * The text a voice task speaks: a script file the contract names (read from the task's worktree), inline text in its
 * inputs or attachments, or a quoted line in its objective. Never the instructions themselves.
 */
export async function speechText(input: RunInput, ctx: RunContext): Promise<string> {
  for (const i of input.contract.inputs) {
    if (i.kind === "text" && i.ref.trim()) return i.ref.trim();
    if ((i.kind === "file" || i.kind === "artifact") && ctx.sandbox.available) {
      const text = await ctx.sandbox.readFile(i.ref).catch(() => "");
      if (text.trim()) return scriptOf(text);
    }
  }
  const attached = input.attachments.find((a) => a.kind !== "repo-map" && a.text?.trim())?.text;
  if (attached) return scriptOf(attached);
  const quoted = /["“]([^"”]{2,})["”]/.exec(input.contract.objective)?.[1];
  if (quoted) return quoted.trim();
  throw new AdapterError(
    "bad_request",
    "nothing to speak: give the task a script (a text input, or a file input such as copy/voiceover.md)",
  );
}

/** Markdown to speakable text: headings, emphasis, links and stage directions in brackets dropped. */
export function scriptOf(markdown: string): string {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .split("\n")
    .filter((l) => !/^\s*(#|<!--|```)/.test(l))
    .join("\n")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const mediaCapabilities = (producesMedia: MediaKind[]) => (): AdapterCapabilities => ({
  taskTypes: [],
  editsFiles: false,
  runsCode: false,
  browses: false,
  producesMedia,
  streaming: false,
  supportsMcpTools: false,
  supportsResume: false,
  runnerModes: ["cloud"],
});

export interface Generated {
  files: ProducedFile[];
  usage?: JobUsage;
  /** The vendor's id for the request, when it gives one. */
  id?: string;
  note?: string;
}

/**
 * A media API that answers in one call (OpenAI, ElevenLabs, Recraft, Ideogram and Gemini by default): the job is the
 * finished result, so limits, cost events and file handling stay those of every other job.
 */
export function createSyncMediaAdapter(v: {
  key: string;
  produces: MediaKind[];
  estimateUsd: number;
  generate(input: RunInput, config: AgentConfig, api: ServiceClient, ctx: RunContext): Promise<Generated>;
}) {
  return createJobAdapter<Generated & { at: string }>({
    key: v.key,
    route: "api" satisfies Route,
    capabilities: mediaCapabilities(v.produces),
    estimateUsd: v.estimateUsd,
    async start(input, config, api, ctx) {
      const g = await v.generate(input, config, api, ctx);
      if (!g.files.length) throw new AdapterError("bad_request", g.note ?? `${v.key} returned no result`);
      return { ...g, at: g.id ?? `${v.key}-${Date.now()}` };
    },
    idOf: (j) => j.at,
    async poll(job) {
      return {
        job,
        state: "done",
        ...(job.usage ? { usage: job.usage } : {}),
        progress: job.files.map((f) => `made ${f.name} (${Math.round(f.bytes.length / 1024)} KB)`),
      };
    },
    async outputs(job) {
      return {
        text: job.note ?? `Made ${job.files.map((f) => f.path ?? f.name).join(", ")}.`,
        files: job.files,
      };
    },
  });
}
