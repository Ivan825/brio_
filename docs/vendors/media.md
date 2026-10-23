# M6 media adapters: wire reference (checked 23 Oct 2026)

All facts below come from vendor docs fetched on 23 Oct 2026: raw Markdown pages, OpenAPI specs, or the doc-site JS bundles. Anything marked **UNVERIFIED** was not confirmed in an official source. Treat model ids as data: list them live where an endpoint exists, and otherwise keep them in `registry/connectors.json` with a `verifiedAt` date.

## Changes since the 23 Oct 2026 registry snapshot

- **Google Veo is gone from the Gemini API.** `veo-3.1-*-preview` shut down on **22 Oct 2026**. `veo-3.0-*` and `veo-2.0` shut down on 30 Jun 2026. Imagen shut down on 17 Aug 2026. Video on the Gemini API now means **`gemini-omni-1.1-flash`** through the **Interactions API** (`/v1beta/interactions`). Images now mean Nano Banana (`gemini-nano-banana-2.1` and others), also through Interactions. GA Veo only exists on Vertex, now called the "Gemini Enterprise Agent Platform". That is a different auth model (GCP), so it is out of scope for BYOK API keys.
- **OpenAI `gpt-image-1` shuts down today (23 Oct 2026).** `gpt-image-1-mini`, `gpt-image-1.5` and `chatgpt-image-latest` shut down on 1 Dec 2026. The current models are `gpt-image-2.5-sunburst` and `gpt-image-2.5-flare`. **All `/v1/audio/speech` models** (`tts-1`, `tts-1-hd`, `gpt-4o-mini-tts*`) are deprecated and shut down on **6 Jan 2027**. Their replacement, `gpt-realtime-2.1-mini`, only works through the Realtime API, not `/audio/speech`.
- **Luma moved to a new "Luma Agents API"** (`agents.lumalabs.ai/v1`, models `ray-3.2`, `uni-1`, `uni-1-max`). The Dream Machine API (`api.lumalabs.ai/dream-machine/v1`, `ray-2`) is legacy and its models are retiring.
- **Kling has a new API shape.** Paths are now `/{capability}/{model}`, e.g. `/text-to-video/kling-4.0`, with a unified `/tasks` endpoint and a plain API key (Bearer). The old `/v1/videos/text2video` path with `model_name` and AK/SK JWT auth is labelled "legacy" in the docs.

---

## 1. OpenAI: images and text-to-speech

| | |
|---|---|
| Base | `https://api.openai.com/v1` |
| Auth | `Authorization: Bearer $OPENAI_API_KEY` |
| Models list | `GET /v1/models` → `{data:[{id, created, owned_by, shutdown_date}]}`. Also the **cheap key check**. `shutdown_date` lets Brio flag deprecations. |
| Image models | `gpt-image-2.5-sunburst`, `gpt-image-2.5-flare` (plus `-2026-09-08` snapshots), `gpt-image-2`, `gpt-image-2-2026-04-21`. Older ones are deprecated (see above). |
| Image call | `POST /images/generations`, **synchronous**, up to about 2 min for complex prompts. Streaming is optional (`stream: true`, `partial_images` 0–3). |
| Image result | Always **base64** (`data[].b64_json`). `url` and `response_format` are not supported for GPT Image. No download step and no expiry. |
| Image metadata | Top-level `size` ("WxH"), `quality`, `output_format`, `background`, `created`. The reference says `usage` (tokens) is documented "for `gpt-image-1` only". For 2.x usage, the guide says to "use the response's `usage`", so **UNVERIFIED** whether it is always present. |
| Image params | `n` 1–10. `size` is `auto`, `1024x1024`, `1536x1024`, `1024x1536`, or any `WxH` with both sides multiples of 16, ratio between 1:3 and 3:1, max 3840x2160, total pixels between 655,360 and 8,294,400. `quality` is `low`, `medium`, `high`, `xhigh`, `max` or `auto` (`xhigh` and `max` only on 2.5). `output_format` is `png` (default), `jpeg` or `webp`. `output_compression` 0–100. `background` is `transparent`, `opaque` or `auto`. `moderation` is `auto` or `low`. Prompt up to 32,000 chars. |
| Image pricing | Token-based, per 1M tokens. Both 2.5 models: image input $8, image output $30, cached image input $2, text input $5. Batch is half price. Each partial image adds 100 output tokens. No flat per-image price for 2.5 (the docs use a calculator). |
| Image errors | `error.type = "image_generation_user_error"`. `error.code = "moderation_blocked"` may include `error.moderation_details`. Do not auto-retry these. |

```http
POST /v1/images/generations
{"model":"gpt-image-2.5-flare","prompt":"a red fox, watercolor","size":"1024x1024","quality":"medium","output_format":"webp"}
→ 200 {"created":1761200000,"data":[{"b64_json":"..."}],"output_format":"webp","quality":"medium","size":"1024x1024","background":"opaque"}
```

**TTS.** Uses `POST /audio/speech`.
- **Models:** `gpt-4o-mini-tts`, `gpt-4o-mini-tts-2025-12-15`, `tts-1`, `tts-1-hd`. All are deprecated and shut down on 6 Jan 2027.
- **Voices:** `alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `onyx`, `nova`, `sage`, `shimmer`, `verse`, `marin`, `cedar`, or a custom `{ "id": "voice_..." }`.
- **Params:** `input` up to 4096 chars. `instructions` (not for tts-1). `response_format` is `mp3` (default), `opus`, `aac`, `flac`, `wav` or `pcm` (24 kHz, 16-bit LE). `speed` 0.25–4.0. `stream_format` is `audio` or `sse` (`sse` not for tts-1).
- **Behaviour:** Synchronous. The response body is raw audio bytes, streamed with chunked transfer.
- **Metadata:** The docs mention **no duration or usage metadata**. Brio must measure duration itself (decode, or compute from PCM length).
- **Pricing:** `tts-1` is $15 per 1M chars, `tts-1-hd` $30 per 1M chars. `gpt-4o-mini-tts` is $0.60 per 1M text-in tokens and $12 per 1M audio-out tokens.

```http
POST /v1/audio/speech
{"model":"gpt-4o-mini-tts","input":"Hello","voice":"marin","response_format":"wav"}
→ 200 audio/wav bytes
```

Docs (verified):
- developers.openai.com/api/docs/guides/image-generation.md
- developers.openai.com/api/reference/resources/images.md
- developers.openai.com/api/docs/guides/text-to-speech.md
- developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create.md
- developers.openai.com/api/docs/deprecations.md
- developers.openai.com/api/docs/pricing.md
- developers.openai.com/api/reference/resources/models/methods/list.md

The old platform.openai.com/docs URLs return 403 to fetchers.

---

## 2. Google Gemini API: Omni video and Nano Banana images

| | |
|---|---|
| Base | `https://generativelanguage.googleapis.com/v1beta` |
| Auth | `x-goog-api-key: $GEMINI_API_KEY` (examples also use `?key=`; use the header to keep keys out of URLs and logs). Background examples add `Api-Revision: 2026-05-20`. **UNVERIFIED** whether it is required for media. |
| Models list | `GET /v1beta/models?pageSize=…` → `{models:[{name, supportedGenerationMethods,…}], nextPageToken}`. Also the **cheap key check**. |
| Video model | `gemini-omni-1.1-flash` (GA, paid tier only, no shutdown date). `gemini-omni-flash-preview` shut down on 22 Oct 2026. **No Veo on this API anymore.** |
| Image models | `gemini-nano-banana-2.1` (recommended), `gemini-3.1-flash-lite-image`, `gemini-3.1-flash-image`, `gemini-3-pro-image`, `gemini-2.5-flash-image` (legacy). Imagen is shut down. |
| Call | `POST /v1beta/interactions` with `{model, input, response_format}`. The **default is synchronous**: the POST returns the finished interaction. Omni docs recommend `background:false, store:false, stream:false`. |
| Async option | `background:true` (requires `store:true`) returns an id. Poll with `GET /v1beta/interactions/{id}`. `status` is `in_progress`, `requires_action`, `completed`, `failed` or `cancelled`. Cancel with `POST /interactions/{id}/cancel`. Docs list background mode for "standard Gemini models and Managed Agents". Whether it works with Omni or Nano Banana is **UNVERIFIED**. |
| Video result | The raw REST response has `steps[]`. The `model_output` step has `content[]` with `{type:"video", mime_type:"video/mp4", data:<base64>}`. `output_video` is SDK-only. Videos over 4 MB: send `response_format.delivery:"uri"`. The content then carries `uri` (`…/files/{id}:download?alt=media`). Poll `GET /v1beta/files/{id}` until `state` is `ACTIVE` (or `FAILED`), then `GET /v1beta/files/{id}:download?alt=media` with the key header. The `uri` is only guaranteed in the create response or SSE; a later GET of the interaction returns base64. |
| Video params | `response_format: {type:"video", aspect_ratio:"16:9"\|"9:16", resolution:"360p"\|"720p"(default)\|"1080p"\|"4k", delivery:"uri"}`. Base clip duration and a duration parameter are **UNVERIFIED** (not documented). Extension adds 3–10 s. |
| Image result | The `model_output` step content has `{type:"image", data:<base64>}`. To get images only, set `response_format:{type:"image", aspect_ratio, image_size:"1K"\|"2K"\|"4K"}` (`"512"`/0.5K only on 3.1 Flash Image). |
| Retention | Interactions are kept 55 days (paid) or 1 day (free) unless `store:false`. Files API objects carry `expirationTime`. The exact TTL of generated files is **UNVERIFIED** (the old Veo docs said 2 days). |
| Metadata | Files API: `sizeBytes`, `mimeType`, `videoMetadata`. Interaction `usage` fields are **UNVERIFIED**. |
| Pricing | Omni Flash: input $1.50 per 1M tokens, video output $17.50 per 1M tokens, billed at 5,792 tokens per second of 720p, **about $0.10/s**. Nano Banana 2.1: image output $30 per 1M tokens, about $0.0336 (1K), $0.0504 (2K), $0.113 (4K) per image. Batch is half price. (The 4K token count differs: 2520 in the image guide vs 3780 on the pricing page.) |

```http
POST /v1beta/interactions
x-goog-api-key: …
{"model":"gemini-omni-1.1-flash","input":"A drone shot over mountains at sunrise",
 "response_format":{"type":"video","resolution":"720p","aspect_ratio":"16:9","delivery":"uri"},
 "store":false}
→ 200 {"id":"v1_…","status":"completed","model":"gemini-omni-1.1-flash","object":"interaction",
       "steps":[{"type":"model_output","content":[{"type":"video","mime_type":"video/mp4",
       "uri":"https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media"}]}]}
GET /v1beta/files/abc → {"state":"PROCESSING"|"ACTIVE"|"FAILED", "expirationTime":…, "sizeBytes":…}
```

The docs' own bash example reads `.output_video.uri`. That contradicts the "SDK-only" note, so parse `steps` instead.

Docs (verified):
- ai.google.dev/gemini-api/docs/omni.md.txt
- ai.google.dev/gemini-api/docs/veo.md.txt (shutdown banner)
- ai.google.dev/gemini-api/docs/image-generation.md.txt
- ai.google.dev/gemini-api/docs/background-execution.md.txt
- ai.google.dev/gemini-api/docs/interactions-overview.md.txt
- ai.google.dev/gemini-api/docs/pricing.md.txt
- ai.google.dev/gemini-api/docs/deprecations.md.txt
- ai.google.dev/api/models.md.txt
- ai.google.dev/api/files.md.txt

---

## 3. Black Forest Labs (FLUX)

| | |
|---|---|
| Base | `https://api.bfl.ai` (global). Regional hosts: `api.eu.bfl.ai`, `api.us.bfl.ai`. |
| Auth | `x-key: $BFL_API_KEY` |
| Models list | **None.** The model is the path: `/v1/{model}`. Endpoints from the OpenAPI spec: `flux-3-image`, `flux-3-image-klein`, `flux-3-video`, `flux-2-pro`, `flux-2-pro-preview`, `flux-2-max`, `flux-2-flex`, `flux-2-klein-9b`, `flux-2-klein-9b-preview`, `flux-2-klein-4b`, `flux-kontext-pro`, `flux-kontext-max`, `flux-pro-1.1`, `flux-pro-1.1-ultra`, `flux-dev`, plus `flux-tools/*`. The spec at `https://api.bfl.ai/openapi.json` can serve as the machine-readable model list. |
| Submit | `POST /v1/{model}` returns `{id, polling_url, cost?, input_mp?, output_mp?}`. `cost` is in credits (1 credit = $0.01). Async only. Optional `webhook_url` and `webhook_secret`. |
| Poll | `GET {polling_url}` with `x-key`. **Always use the returned `polling_url`.** Status values: `Pending`, `Reasoning`, `Generating` (non-terminal); `Ready`, `Request Moderated`, `Content Moderated`, `Error`, `Task not found` (terminal). The spec also lists `No Card Generated`. The settled result includes `cost`. |
| Result | `result.sample` is a signed URL on `delivery.*.bfl.ai`. No CORS, so download server-side, and **do not** send `x-key` to it. **Expiry conflicts across docs:** 10 min (integration guide), 1 h (FLUX 3 Image page), about 2 h (video cookbook). Download immediately. |
| flux-3-image body | `prompt` (required). `images` (URLs or base64, up to 10 refs). `aspect_ratio`: one of 21:9 … 9:21 or `auto`. `resolution`: `768sq`, `1k`, `1.5k`, `2k`, `4k` or `match_input`. Or `width`/`height` (256–6256). Also `safety_tolerance` 0–7, `grounding` (bool), `version:"latest"`. |
| flux-2-pro body | `prompt`, `input_image`…`input_image_8`, `width`/`height`, `seed`, `output_format` (`jpeg`, `png` or `webp`; default jpeg), `safety_tolerance`, `disable_pup`. |
| flux-3-video body | Discriminated on **`mode`**: `t2v`, `i2v`, `v2v` or `draft_enhance`. T2V: `prompt`, `mode:"t2v"`, `aspect_ratio`, `duration` (5–20 or `auto`), `resolution` (`hd`, `fhd`, `qhd` or `uhd`), `generate_audio` (default true), `draft`. Output is MP4 at 24 fps with synced audio. The cookbook uses path `flux-3-preview-high` and `480p`/`720p`, which conflicts with the OpenAPI spec. Follow the spec. |
| Pricing | Credits ($0.01 each). Images are priced per image or per MP; video per second, by resolution class. The pricing page loads its numbers client-side, so **per-model numbers are UNVERIFIED**. Use the `cost` field from the submit and settled responses. |
| Key check | `GET /v1/credits` → `{credits}` |

```http
POST https://api.bfl.ai/v1/flux-3-image   x-key: …
{"prompt":"isometric tiny city","resolution":"1k","aspect_ratio":"16:9"}
→ {"id":"…","polling_url":"https://api.bfl.ai/v1/get_result?id=…","cost":…}
GET polling_url → {"id":"…","status":"Ready","result":{"sample":"https://delivery.eu1.bfl.ai/…"},"cost":…}
```

Docs (verified):
- api.bfl.ai/openapi.json
- docs.bfl.ml/llms.txt
- docs.bfl.ml/api_integration/integration_guidelines.md
- docs.bfl.ml/flux_3/flux3_image_generate.md
- docs.bfl.ml/cookbook/video_quickstart.md
- docs.bfl.ml/quick_start/pricing.md

---

## 4. Runway

| | |
|---|---|
| Base | `https://api.dev.runwayml.com` |
| Auth | `Authorization: Bearer $RUNWAYML_API_SECRET` plus the **required** `X-Runway-Version: 2024-11-06` |
| Models list | **No list endpoint.** Valid ids are per-endpoint discriminators in `https://docs.dev.runwayml.com/openapi.json`. Parse those `const` values for a live list. |
| Endpoints | `POST /v1/text_to_video`, `/v1/image_to_video`, `/v1/video_to_video`, `/v1/text_to_image`, `/v1/text_to_speech`, `/v1/sound_effect`, `/v1/image_upscale`, `/v1/video_upscale` and others. Router variants: `/v1/generate/{video\|image\|audio}`. |
| text_to_video models | `gen4.5`, `veo3.1`, `veo3.1_fast`, `gemini_omni_flash`, `gemini_omni_flash_1.1`, `kling2.5_turbo_pro`, `kling3.0_standard`, `kling3.0_pro`, `kling3.0_4k`, `seedance2`, `seedance2_5`, `seedance2_fast`, `seedance2_mini`, `wan3`, `wan3_prime`, `hailuo3`, `h3_max`, `happyhorse_1_0`, `grok_imagine_1_5`, `grok_imagine_1_5_lite`. `image_to_video` adds `gen4_turbo`. Retired: `gen3a_turbo`, `gen4_aleph`. |
| Per-model rules | Bodies are discriminated on `model`, so ratio, duration and prompt limits change per model. `gen4.5` T2V: `promptText` (≤1000 chars), `ratio` `1280:720` or `720:1280`, `duration` 2–10 (all required). I2V adds `promptImage` (HTTPS URL, data URI or upload URI) and ratios `1104:832`, `960:960`, `832:1104`, `1584:672`. Optional `outputFormat` (`mp4` default, `prores`, `png_sequence`, HDR variants). |
| Submit | → `{ "id": "<uuid>" }` (async) |
| Poll | `GET /v1/tasks/{id}`. Status `PENDING`, `THROTTLED` (queued, not an error), `RUNNING` (with `progress` 0–1), `SUCCEEDED`, `FAILED` (`failure`, `failureCode`) or `CANCELLED`. Non-terminal states carry `estimatedCost.credits`; terminal states carry `cost.credits`. `DELETE /v1/tasks/{id}` cancels a running task or deletes a finished one. Moderation shows up as `FAILED`, and is **charged**. |
| Result | `output[]` URLs expire in **24–48 h**. Re-fetching the task returns fresh URLs. No duration or size fields in the task, so probe the file. |
| Pricing | $0.01 per credit. Per second: `gen4.5` 12 cr/s, `gen4_turbo` 5, `veo3.1` 40 (audio) or 20, `veo3.1_fast` 15 or 10, `gemini_omni_flash_1.1` 10 cr/s at 720p, `kling3.0_pro` 17 (audio) or 12, `seedance2` 36 (480/720p). Images: `gen4_image` 5 cr (720p) or 8 (1080p), `gen4_image_turbo` 2, `nano_banana_2.1` 4/6/12 (1K/2K/4K). |
| Key check | `GET /v1/organization` → `{tier, creditBalance, usage}` |

```http
POST /v1/text_to_video   Authorization: Bearer …   X-Runway-Version: 2024-11-06
{"model":"gen4.5","promptText":"timelapse of clouds","ratio":"1280:720","duration":5}
→ {"id":"6f…"}
GET /v1/tasks/6f… → {"id":"6f…","status":"SUCCEEDED","output":["https://…mp4"],"cost":{"credits":60},"createdAt":"…"}
```

Docs (verified):
- docs.dev.runwayml.com/ai-context.md
- docs.dev.runwayml.com/openapi.json
- docs.dev.runwayml.com/guides/pricing.md
- docs.dev.runwayml.com/assets/outputs.md

---

## 5. Luma (Luma Agents API; Dream Machine is legacy)

| | |
|---|---|
| Base | `https://agents.lumalabs.ai/v1` |
| Auth | `Authorization: Bearer $LUMA_AGENTS_API_KEY` (keys from platform.lumalabs.ai) |
| Models | `ray-3.2` (video), `uni-1` and `uni-1-max` (image). **No documented models-list endpoint.** `GET /v1/models` returns 401 without a key; it is probably the LLM-inference (OpenAI-compatible) surface, but that is **UNVERIFIED**. |
| Submit | `POST /v1/generations` with `type` set to `image`, `image_edit`, `video`, `video_edit`, `video_reframe` or `layering`. Returns a `Generation` object (async). |
| Video body | `{model:"ray-3.2", type:"video", prompt, aspect_ratio, video:{resolution:"540p"\|"720p"\|"1080p", duration:"5s"\|"10s", start_frame?, end_frame?, keyframes?, loop?, hdr?, exr_export?}}`. Aspect ratios: 9:16, 3:4, 1:1, 4:3, 16:9, 21:9. Start and end frames are not allowed with 10s. |
| Image body | `{model:"uni-1", prompt, aspect_ratio, image_ref?[≤9], output_format:"png"\|"jpeg"}`. `model` defaults to `uni-1`. |
| Poll | `GET /v1/generations/{id}`. `state` is `queued`, `processing`, `completed` or `failed`. `failure_code` is one of `content_moderated`, `generation_failed`, `budget_exhausted`, `output_not_found`, `image_too_large`, `unsupported_format`, `corrupt_input`, `invalid_request`, `rate_limited`. Docs suggest polling every 2 s; video timeout about 10 min. |
| Result | `output[]` items have `{type, url}`. Presigned URLs expire after **1 h**; poll again for a fresh URL. No duration or size metadata, so probe the file. |
| Pricing (USD) | `uni-1` $0.0404 per image (2K); `uni-1-max` $0.10. `ray-3.2` SDR video per 5 s / 10 s: 540p $0.15 / $0.45, 720p $0.30 / $0.90, 1080p $1.20 / $3.60. HDR costs more. Moderated or failed generations are refunded. |
| Key check | `GET /v1/files?limit=1` (documented list endpoint; using it as a key check is Brio's choice) |

```http
POST https://agents.lumalabs.ai/v1/generations
{"model":"ray-3.2","type":"video","prompt":"slow dolly through a misty greenhouse","aspect_ratio":"16:9","video":{"resolution":"720p","duration":"5s"}}
→ {"id":"…","state":"queued","model":"ray-3.2","type":"video","created_at":"…"}
GET /v1/generations/{id} → {"state":"completed","output":[{"type":"video","url":"https://…"}]}
```

**Legacy Dream Machine API** (only for accounts still on it): `POST https://api.lumalabs.ai/dream-machine/v1/generations` with `{prompt, model:"ray-2"|"ray-flash-2", resolution, duration:"5s"}`. Ray 2 and 3 are retiring.

Docs (verified):
- docs.agents.lumalabs.ai (Quickstart, Models, Video generation, Pricing, Migration)
- docs.agents.lumalabs.ai/api/resources/generations/methods/{create,get}/index.md
- docs.lumalabs.ai/docs/video-generation.md (legacy)

---

## 6. Kling (official API exists: Kuaishou "KlingAI Open Platform")

| | |
|---|---|
| Base | `https://api-singapore.klingai.com` (global). `https://api-beijing.klingai.com` (China). The docs say the API "has been changed from `https://api.klingai.com`". |
| Auth | `Authorization: Bearer <API Key>`. The docs call this "API Key (for all models)"; the key is created once in the developer console. The legacy alternative is a JWT (HS256) signed with the secret key, payload `{iss: accessKey, exp: now+1800, nbf: now-5}`, sent as `Bearer <jwt>`. |
| Models | Model is in the path: `/text-to-video/kling-4.0`, `/text-to-video/kling-3.0-turbo`, `/text-to-video/kling-2.6`, `/image-to-video/…`, `/video-omni/…`. 4.0-flash and 3.0-omni variants exist. **No models-list endpoint found.** Legacy `model_name` ids: `kling-v3`, `kling-v3-omni`, `kling-video-o1`, `kling-v2-6`, `kling-v2-5-turbo`, … on `POST /v1/videos/text2video`. |
| kling-4.0 T2V body | `{prompt, settings:{duration (≤30; default 10, or inferred from the prompt), resolution:"720p"\|"1080p"(default), aspect_ratio:"21:9"\|"16:9"(default)\|"9:16"\|"1:1"}, options:{callback_url, external_task_id, watermark_info:{enabled}}}` |
| Submit response | `{code:0, message, request_id, data:{id, status, create_time, update_time, external_id}}` (async). Check `code` even on HTTP 200. |
| Poll | `GET /tasks?task_ids=<id>` (comma-separated batch allowed) or `?external_task_ids=`. Returns `data.result[]` with `{id, status: submitted\|processing\|succeeded\|failed, message, outputs[], billing[], usage?}`. Listing is `POST /tasks` with cursor and filters. |
| Result | `outputs[]` video items have `{type:"video", id, url, watermark_url, duration}` (duration as a string, in seconds). Audio items have `mp3_url`/`wav_url` and `*_duration`. Results are **kept 30 days**; URLs are hotlink-protected. `billing[]` has `{charge_type: cash\|unit, amount, currency, package_type}`. |
| Pricing (from kling.ai/llms.txt, marked "verified 2026-05-29") | `kling-v3` std: $0.084/s (no audio) or $0.126/s (audio). Pro: $0.112 or $0.168/s. 4K: $0.42/s. **Kling 4.0 and 4.0-flash prices are UNVERIFIED.** The task's `billing` reports the actual charge. |
| Key check | `GET /account/costs?start_time=…&end_time=…` (documented account endpoint) |

Kling is also reachable through Runway (`kling3.0_*`, `kling2.5_turbo_pro`) and Ideogram (Kling v3 Standard).

```http
POST https://api-singapore.klingai.com/text-to-video/kling-4.0   Authorization: Bearer $KLING_API_KEY
{"prompt":"a girl on a train looking out the window","settings":{"duration":10,"resolution":"1080p","aspect_ratio":"16:9"}}
→ {"code":0,"request_id":"…","data":{"id":"t_…","status":"submitted",…}}
GET /tasks?task_ids=t_… → {"code":0,"data":{"result":[{"id":"t_…","status":"succeeded","outputs":[{"type":"video","url":"…","duration":"10"}],"billing":[…]}]}}
```

Docs (verified via the doc-site bundle, because the HTML is a JS SPA):
- kling.ai/document-api/apiReference/commonInfo (auth)
- kling.ai/document-api/… (text-to-video kling-4.0, query-task)
- kling.ai/llms.txt (hosts, prices)

Request and response field names were confirmed from those bundle sources.

---

## 7. ElevenLabs text-to-speech

| | |
|---|---|
| Base | `https://api.elevenlabs.io`. Regional hosts: `api.us.elevenlabs.io`, `api.eu.residency.elevenlabs.io`, `api.in.residency…`, `api.sg.residency…`. |
| Auth | `xi-api-key: $ELEVENLABS_API_KEY` |
| Models list | `GET /v1/models` → `[{model_id, can_do_text_to_speech, maximum_text_length_per_request, token_cost_factor, model_rates, languages, …}]`. Filter on `can_do_text_to_speech`. Voices: `GET /v1/voices`. |
| Current TTS ids | `eleven_v4`, `eleven_v4_turbo`, `eleven_v3`, `eleven_v3_conversational`, `eleven_multilingual_v2` (the API default), `eleven_flash_v2_5`, `eleven_flash_v2`. Deprecated: `eleven_turbo_v2_5`, `eleven_turbo_v2`. Character limits: v4 10k, v3 5k, flash v2.5 40k, multilingual v2 10k. |
| Call | `POST /v1/text-to-speech/{voice_id}?output_format=mp3_44100_128` with `{text, model_id, voice_settings?, language_code?, seed?, previous_text?, next_text?}`. **Synchronous**; returns `audio/mpeg` bytes. Streaming variant: `/stream`. |
| Format / duration | Format is chosen by `output_format` (`codec_samplerate[_bitrate]`): mp3, opus, pcm, wav, ulaw or alaw. 192 kbps MP3 needs Creator tier; 44.1 kHz PCM/WAV needs Pro. **The plain endpoint returns no duration.** `POST /v1/text-to-speech/{voice_id}/with-timestamps` returns JSON `{audio_base64, alignment:{characters, character_start_times_seconds, character_end_times_seconds}, normalized_alignment}`, so duration is about the last end time. The field names inside `alignment` are **UNVERIFIED**; the schema was not expanded. |
| Cost metadata | Response headers: `character-cost`, `request-id`, `x-trace-id`. One localized page says `x-character-count`, so read both. |
| Pricing (API, USD) | v4, v3 and Multilingual v2: $0.08 per 1K chars. Flash/Turbo: $0.04 per 1K chars. Billed in dollars, not credits. |
| Key check | `GET /v1/user` (or `GET /v1/models`) |

```http
POST /v1/text-to-speech/21m00Tcm4TlvDq8ikWAM?output_format=mp3_44100_128   xi-api-key: …
{"text":"Hello from Brio","model_id":"eleven_flash_v2_5"}
→ 200 audio/mpeg  (headers: character-cost: 15, request-id: …)
```

Docs (verified):
- api.elevenlabs.io/openapi.json
- elevenlabs.io/docs/api-reference/text-to-speech/convert.md
- elevenlabs.io/docs/overview/models.md
- elevenlabs.io/docs/api-reference/introduction.md
- elevenlabs.io/pricing/api

---

## 8. Ideogram (API v2)

| | |
|---|---|
| Base | `https://api.ideogram.ai` |
| Auth | `Api-Key: $IDEOGRAM_API_KEY` |
| Models | Model is in the path: `POST /v2/{content}/{action}/{model}`. Generate models: `ideogram-4-5`, `ideogram-4`, `ideogram-4-transparent`, `ideogram-3`, `ideogram-2a`, `ideogram-2`, `auto`. Third-party: `gpt-image-2-5-flare`, `gpt-image-2-5-sunburst`, `gpt-image-2`, `nano-banana-2`, `nano-banana-2-1`, `nano-banana-pro`, `z-image`, `p-image-ideogram`. Video: `kling-3-standard-*`, `seedance-2*`, `minimax-h3-*`. **No list endpoint**; parse `https://api.ideogram.ai/openapi.json` paths. |
| Generate | `POST /v2/image/generate/ideogram-4-5`. The spec says `multipart/form-data`; the official quickstart also sends JSON. Fields: `prompt` (≤10,000 chars, required), `magic_prompt` (auto/on/off), `size` (`auto`, `source` or `WxH` preset), `background` (auto/transparent/…), `quality` (`very_low`, `low`, `medium`, `high`; default `high` with no source images), `num_images` 1–8, `seed`, `async`, `webhook_url`. |
| Sync/async | **Image endpoints are synchronous by default** and return `{generation_kind, generation_id, seed, data:[{url, resolution:"WxH", is_image_safe, prompt, seed}]}`. Video and tool endpoints are always async; image endpoints are async when `async:true` or a `webhook_url` is set. |
| Poll | `GET /v2/generations/{generation_id}`. `status` is `pending`, `completed` or `failed` (`failure_reason`, e.g. `content_policy_violation`). Completed responses carry `data[]` and an optional `usage_cost_usd_micros`. 402 and 429 responses carry `reject_reason` (e.g. `inflight_limit`). |
| Result | `data[].url`. Docs say "image URLs expire"; the **exact TTL is UNVERIFIED**. `url` is empty when `is_image_safe:false`. |
| Pricing | Pay-as-you-go at 1¢ per credit. Per-model prices load client-side, so **UNVERIFIED**. Use `usage_cost_usd_micros` where returned, or `GET /v2/account/usage`. |
| Key check | `GET /v2/account/api-keys` or `GET /v2/account/usage` |

```http
POST https://api.ideogram.ai/v2/image/generate/ideogram-4-5   Api-Key: …   Content-Type: application/json
{"prompt":"knit running shoes in neon coral, soft window light"}
→ {"generation_kind":"…","generation_id":"…","seed":123,"data":[{"url":"https://…","resolution":"1024x1024","is_image_safe":true,"prompt":"…","seed":123}]}
```

Docs (verified):
- api.ideogram.ai/openapi.json
- developer.ideogram.ai/v2/llms.txt
- developer.ideogram.ai/v2/ideogram-api/api-overview.md

---

## 9. Recraft

| | |
|---|---|
| Base | `https://external.api.recraft.ai/v1` |
| Auth | `Authorization: Bearer $RECRAFT_API_TOKEN`. The account needs a positive API-unit balance; 1 USD = 1,000 units. |
| OpenAI-compatible? | **Partly.** `POST /v1/images/generations` follows the OpenAI Images shape, and the OpenAI SDK works with `base_url`. Recraft-specific fields (`image_format`, `controls`, `style_id`, …) must go in `extra_body`. Plain fetch is fine. |
| Models | `recraftv4_1` (default), `recraftv4_1_flash`, `recraftv4_1_vector`, `recraftv4_1_pro`, `recraftv4_1_pro_vector`, `recraftv4_1_utility*`, `recraftv4_styles*`, `recraftv4*`, `recraftv3`, `recraftv3_vector`, `recraftv2`, `recraftv2_vector`. **No models-list endpoint documented.** |
| Call | **Synchronous.** Body: `{prompt, model, n(1–6), size("w:h" ratio or an exact WxH from the model's list), response_format:"url"\|"b64_json"\|"multipart", image_format:"webp"(default)\|"png", controls?, style_id?}`. Prompt limit: 10,000 chars (v4.x), 1,000 (v2/v3). |
| Response | `{created, credits, data:[{image_id, url\|b64_json}]}`. `credits` is the API units charged. Vector models return SVG. URLs are temporary (**about 24 h**). Errors may be `text/plain` (401 returns `request unauthorized`). |
| Pricing (per image) | v4.1 Flash $0.007; v4.1 $0.035; v4.1 vector $0.08; v4.1 Pro (2K) $0.21; v4 $0.04; v3 $0.04; v2 $0.022. Style refs add $0.005. |
| Limits | 100 images/min, 5 req/s |
| Key check | `GET /v1/users/me` → `{id, email, name, credits}` |

```http
POST https://external.api.recraft.ai/v1/images/generations   Authorization: Bearer …
{"prompt":"two race cars on a track","model":"recraftv4_1","size":"16:9"}
→ {"created":1759140000,"credits":35,"data":[{"image_id":"0e6a…","url":"https://…"}]}
```

Docs (verified):
- recraft.ai/docs/api-reference/agents.md
- recraft.ai/docs/api-reference/clients.md
- recraft.ai/docs/llms.txt

---

## Adapter notes for Brio

- **Sync providers:** OpenAI images and TTS, ElevenLabs, Recraft, Ideogram images (by default), and Gemini Interactions (by default). Their results are inline base64, bytes or short-lived URLs.
- **Async providers:** BFL (`polling_url`), Runway (`/v1/tasks`), Luma (`/v1/generations/{id}`), Kling (`/tasks`), Ideogram video, and Gemini with `delivery:"uri"`. Gemini's poll goes through the Files API `state`.
- **Download every result straight into Brio storage.** URL lifetimes: BFL 10 min to 2 h, Luma 1 h, Recraft about 24 h, Runway 24–48 h, Kling 30 days, Gemini files TTL unverified.
- **Cost reported by the provider:** BFL `cost`, Runway `cost.credits`, Kling `billing[]`, Ideogram `usage_cost_usd_micros`, Recraft `credits`, ElevenLabs `character-cost` header, OpenAI image `usage` (gpt-image-1 documented). **Not reported:** Luma, OpenAI TTS and Gemini. Estimate those from the price tables and mark them as estimates.
- **Duration and format metadata:** Kling (`duration`), Gemini Files `videoMetadata`, and ElevenLabs with-timestamps. Everyone else needs `ffprobe` on the downloaded file in the sandbox runner.
