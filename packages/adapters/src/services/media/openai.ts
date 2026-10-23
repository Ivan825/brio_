// OpenAI images and speech (docs/vendors/media.md §1). Images: one synchronous call, base64 results; sizes are WxH
// with both sides multiples of 16. Speech: raw audio bytes, billed per character; every /audio/speech model shuts
// down on 6 Jan 2027 (the registry notes it).
import { AdapterError } from "../../errors";
import {
  b64,
  closestRatio,
  createSyncMediaAdapter,
  mediaFile,
  mediaPrompt,
  mediaShape,
  pickFormat,
  speechText,
} from "./common";

const SIZES: Record<string, string> = { "1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536" };
const MAX_PIXELS = 8_294_400;
const MIN_PIXELS = 655_360;

/** The size to ask for: the exact one the check wants when the API allows it, else the nearest preset ratio. */
export function openaiImageSize(shape: ReturnType<typeof mediaShape>): string {
  const { width: w, height: h } = shape;
  if (w && h) {
    const r = (x: number) => Math.max(16, Math.round(x / 16) * 16);
    const [W, H] = [r(w), r(h)];
    const ratio = W / H;
    if (W * H <= MAX_PIXELS && W * H >= MIN_PIXELS && ratio <= 3 && ratio >= 1 / 3 && W <= 3840 && H <= 3840)
      return `${W}x${H}`;
  }
  if (!shape.aspect) return "auto";
  return SIZES[closestRatio(shape.aspect, Object.keys(SIZES))] as string;
}

export const openaiImage = createSyncMediaAdapter({
  key: "openai-image",
  produces: ["image"],
  estimateUsd: 0.2,
  async generate(input, config, api) {
    const shape = mediaShape(input);
    const format = pickFormat(shape, ["png", "jpeg", "webp"] as const, "png");
    const r = await api.json<{
      created?: number;
      data?: Array<{ b64_json?: string; revised_prompt?: string }>;
      size?: string;
      quality?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>(
      "POST",
      "/images/generations",
      {
        model: config.model,
        prompt: mediaPrompt(input, "image", 32_000),
        n: 1,
        size: openaiImageSize(shape),
        output_format: format,
        ...(typeof config.options?.quality === "string" ? { quality: config.options.quality } : {}),
        ...(config.options?.background ? { background: config.options.background } : {}),
      },
      // Moderation refusals are final: no retry.
      { retries: 0, timeoutMs: 5 * 60_000 },
    );
    const images = (r.data ?? []).filter((d) => d.b64_json);
    return {
      files: images.map((d, i) =>
        mediaFile(
          input,
          "image",
          `image/${format}`,
          b64(d.b64_json as string),
          { model: config.model, size: r.size, quality: r.quality },
          i,
        ),
      ),
      usage: { units: images.length },
    };
  },
});

export const openaiSpeech = createSyncMediaAdapter({
  key: "openai-speech",
  produces: ["audio"],
  estimateUsd: 0.05,
  async generate(input, config, api, ctx) {
    const text = await speechText(input, ctx);
    if (text.length > 4096)
      throw new AdapterError(
        "bad_request",
        `the script is ${text.length} characters; OpenAI speech takes 4,096`,
      );
    const format = pickFormat(mediaShape(input), ["mp3", "wav", "flac", "aac", "opus"] as const, "mp3");
    const voice = typeof config.options?.voice === "string" ? config.options.voice : "alloy";
    const r = await api.bytes("/audio/speech", {
      method: "POST",
      body: {
        model: config.model,
        input: text,
        voice,
        response_format: format,
        ...(config.rolePrompt && !config.model.startsWith("tts-1")
          ? { instructions: config.rolePrompt.slice(0, 2000) }
          : {}),
      },
    });
    const type = format === "mp3" ? "audio/mpeg" : `audio/${format}`;
    return {
      files: [
        mediaFile(input, "audio", r.contentType.startsWith("audio/") ? r.contentType : type, r.bytes, {
          model: config.model,
          voice,
          characters: text.length,
        }),
      ],
      usage: { units: text.length },
    };
  },
});
