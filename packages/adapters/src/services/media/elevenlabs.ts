// ElevenLabs text-to-speech (docs/vendors/media.md §7): one synchronous call per script, audio bytes back, the
// characters billed in the character-cost header. The agent's model is the TTS model; its voice is options.voiceId.
import { AdapterError } from "../../errors";
import { createSyncMediaAdapter, mediaFile, mediaShape, pickFormat, speechText } from "./common";

/** A voice from ElevenLabs' default library, used when the agent names none. */
export const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";

const FORMATS = { mp3: "mp3_44100_128", wav: "wav_44100" } as const;

export const elevenlabs = createSyncMediaAdapter({
  key: "elevenlabs",
  produces: ["audio"],
  estimateUsd: 0.1,
  async generate(input, config, api, ctx) {
    const text = await speechText(input, ctx);
    const max = Number(config.options?.maxCharacters ?? 10_000);
    if (text.length > max)
      throw new AdapterError(
        "bad_request",
        `the script is ${text.length} characters; ${config.model} takes ${max}`,
      );
    const voice = typeof config.options?.voiceId === "string" ? config.options.voiceId : DEFAULT_VOICE;
    if (!/^[\w-]+$/.test(voice)) throw new AdapterError("misconfigured", "the voice id is not valid");
    const format = pickFormat(mediaShape(input), ["mp3", "wav"] as const, "mp3");
    const r = await api.bytes(`/v1/text-to-speech/${voice}`, {
      method: "POST",
      query: { output_format: FORMATS[format] },
      body: {
        text,
        model_id: config.model,
        ...(typeof config.options?.languageCode === "string"
          ? { language_code: config.options.languageCode }
          : {}),
      },
    });
    const charged = Number(
      r.headers.get("character-cost") ?? r.headers.get("x-character-count") ?? Number.NaN,
    );
    return {
      files: [
        mediaFile(input, "audio", format === "mp3" ? "audio/mpeg" : "audio/wav", r.bytes, {
          model: config.model,
          voice,
          characters: text.length,
        }),
      ],
      usage: { units: Number.isFinite(charged) ? charged : text.length },
      ...(r.headers.get("request-id") ? { id: r.headers.get("request-id") as string } : {}),
    };
  },
});
