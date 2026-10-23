// Recraft (docs/vendors/media.md §9): the OpenAI Images shape (POST /images/generations), synchronous, base64 asked
// for so nothing expires; vector models return SVG. The units charged come back in `credits` (1,000 to the dollar).
import {
  b64,
  closestRatio,
  createSyncMediaAdapter,
  mediaFile,
  mediaPrompt,
  mediaShape,
  pickFormat,
} from "./common";

type Answer = { created?: number; credits?: number; data?: Array<{ image_id?: string; b64_json?: string }> };

const RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "4:5", "5:4"];

export const recraft = createSyncMediaAdapter({
  key: "recraft",
  produces: ["image"],
  estimateUsd: 0.05,
  async generate(input, config, api) {
    const shape = mediaShape(input);
    const vector = /vector/.test(config.model);
    const format = vector ? "svg" : pickFormat(shape, ["webp", "png"] as const, "png");
    const r = await api.json<Answer>(
      "POST",
      "/images/generations",
      {
        prompt: mediaPrompt(input, "image", /v[23]/.test(config.model) ? 1000 : 10_000),
        model: config.model,
        n: 1,
        size: closestRatio(shape.aspect ?? 1, RATIOS),
        response_format: "b64_json",
        ...(vector ? {} : { image_format: format }),
        ...(typeof config.options?.styleId === "string" ? { style_id: config.options.styleId } : {}),
      },
      { retries: 0, timeoutMs: 5 * 60_000 },
    );
    const images = (r.data ?? []).filter((d) => d.b64_json);
    return {
      files: images.map((d, i) =>
        mediaFile(
          input,
          "image",
          vector ? "image/svg+xml" : `image/${format}`,
          b64(d.b64_json as string),
          { model: config.model, imageId: d.image_id },
          i,
        ),
      ),
      usage: { units: r.credits ?? 0 },
    };
  },
});
