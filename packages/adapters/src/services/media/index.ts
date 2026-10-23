// Media models (ADAPTER_SPEC §2.8): images, video and voice from official APIs, each a job whose results are files.
import type { AgentAdapter } from "../../types";
import { elevenlabs } from "./elevenlabs";
import { flux } from "./flux";
import { googleMedia } from "./google";
import { ideogram } from "./ideogram";
import { kling } from "./kling";
import { luma } from "./luma";
import { openaiImage, openaiSpeech } from "./openai";
import { recraft } from "./recraft";
import { runway } from "./runway";

export const MEDIA_ADAPTERS: readonly AgentAdapter[] = [
  openaiImage,
  openaiSpeech,
  googleMedia,
  flux,
  runway,
  luma,
  kling,
  elevenlabs,
  ideogram,
  recraft,
];

export { mediaShape, scriptOf, speechText } from "./common";
