// Ideogram v2 (docs/vendors/media.md §8): images are synchronous (POST /v2/image/generate/{model}) and come back as
// URLs to fetch at once; an unsafe image has no URL. The cost is reported in micro-dollars when Ideogram gives it.
import { AdapterError } from "../../errors";
import { closestRatio, createSyncMediaAdapter, download, mediaPrompt, mediaShape } from "./common";

type Answer = {
  generation_id?: string;
  data?: Array<{ url?: string; resolution?: string; is_image_safe?: boolean; seed?: number }>;
  usage_cost_usd_micros?: number;
};

const SIZES = ["1024x1024", "1280x720", "720x1280", "1536x1024", "1024x1536", "1344x768", "768x1344"];

/** The size to ask for: an exact WxH from the check, or the nearest common preset by aspect, or auto. */
export function ideogramSize(shape: ReturnType<typeof mediaShape>): string {
  if (shape.width && shape.height) return `${shape.width}x${shape.height}`;
  return shape.aspect ? closestRatio(shape.aspect, SIZES) : "auto";
}

export const ideogram = createSyncMediaAdapter({
  key: "ideogram",
  produces: ["image"],
  estimateUsd: 0.1,
  async generate(input, config, api) {
    if (!/^[\w.-]+$/.test(config.model))
      throw new AdapterError("misconfigured", `not an Ideogram model: ${config.model}`);
    const shape = mediaShape(input);
    const r = await api.json<Answer>(
      "POST",
      `/v2/image/generate/${config.model}`,
      {
        prompt: mediaPrompt(input, "image", 10_000),
        size: ideogramSize(shape),
        num_images: 1,
        ...(config.options?.magicPrompt
          ? { magic_prompt: config.options.magicPrompt }
          : { magic_prompt: "off" }),
        ...(config.options?.background ? { background: config.options.background } : {}),
      },
      { retries: 0, timeoutMs: 5 * 60_000 },
    );
    const urls = (r.data ?? []).filter((d) => d.url && d.is_image_safe !== false).map((d) => d.url as string);
    const files = await download(api, input, "image", urls, {
      model: config.model,
      generation: r.generation_id,
    });
    return {
      files,
      usage:
        r.usage_cost_usd_micros !== undefined
          ? { usd: r.usage_cost_usd_micros / 1e6, units: files.length }
          : { units: files.length },
      ...(r.generation_id ? { id: r.generation_id } : {}),
      ...(files.length ? {} : { note: "Ideogram marked every result unsafe; nothing was returned" }),
    };
  },
});
