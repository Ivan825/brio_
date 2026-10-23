// The media contract (ADAPTER_SPEC §2.8) for every media service, against fakes built from each vendor's documented
// wire format (docs/vendors/media.md): the key check, a run that asks for the shape the task's media_spec check wants,
// downloads the result at once (without the key on presigned hosts), places it at the contract's output path, meters
// it in the vendor's unit, and never lets the key into what the run emits.
import { registry } from "@brio/registry";
import { describe, expect, it } from "vitest";
import { ADAPTERS } from "../src/index";
import { closestRatio, mediaShape, scriptOf } from "../src/services/media/common";
import { openaiImageSize } from "../src/services/media/openai";
import type { AdapterEvent, AgentAdapter, AgentConfig, RunContext, RunInput } from "../src/types";
import { helloInput, secret } from "./contract";
import { FakeService } from "./service-fakes";

// Built at runtime so no key-shaped literal sits in the repository.
const KEY = ["media", "key", "0123456789abcdefghijklmnop"].join("-");

const u8 = (...parts: Array<number[] | string>) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const box = (type: string, body: number[]) => [
  ...be32(8 + body.length),
  ...[...type].map((c) => c.charCodeAt(0)),
  ...body,
];

const png = (w: number, h: number) =>
  u8([0x89], "PNG\r\n\x1a\n", be32(13), "IHDR", be32(w), be32(h), [8, 6, 0, 0, 0]);
const mp4 = (seconds: number, w = 1280, h = 720) => {
  const mvhd = box("mvhd", [
    0,
    0,
    0,
    0,
    ...be32(0),
    ...be32(0),
    ...be32(1000),
    ...be32(seconds * 1000),
    ...Array(80).fill(0),
  ]);
  const tkhd = box("tkhd", [0, 0, 0, 3, ...Array(72).fill(0), ...be32(w * 65536), ...be32(h * 65536)]);
  return u8(
    box("ftyp", [...[..."isom"].map((c) => c.charCodeAt(0)), 0, 0, 2, 0]),
    box("moov", [...mvhd, ...box("trak", tkhd)]),
  );
};
/** 128 kb/s MPEG-1 layer III at 44.1 kHz: a frame header, then enough bytes for the duration. */
const mp3 = (seconds: number) => u8([0xff, 0xfb, 0x90, 0x00], Array(seconds * 16_000 - 4).fill(0));
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const file = (b: Uint8Array, type: string, headers: Record<string, string> = {}) =>
  new Response(b, { headers: { "content-type": type, ...headers } });

type Kind = "image" | "video" | "voice";

interface MediaCase {
  service: string;
  model: string;
  kind: Kind;
  authed: (h: Record<string, string>) => boolean;
  install: (f: FakeService, script: "done" | "forever") => void;
  /** What the request to start the job must carry. */
  request: (f: FakeService) => void;
  contentType: string;
  /** USD metered for the run at the registry's unit price (or as the vendor reported). */
  usd: number;
  /** Polls until cancelled; the cancel call it must make, if the vendor has one. */
  cancelCall?: { method: string; path: RegExp };
}

const SCRIPT = "# Voiceover\n\nMeet **Brio**: one goal, many agents, [one result](https://brio.dev).\n";
const SPOKEN = "Meet Brio: one goal, many agents, one result.";

const CASES: MediaCase[] = [
  {
    service: "openai-image",
    model: "gpt-image-2.5-flare",
    kind: "image",
    authed: (h) => h.authorization === `Bearer ${KEY}`,
    install: (f) =>
      void f.on("POST", /^\/v1\/images\/generations$/, () => ({
        created: 1,
        data: [{ b64_json: b64(png(1536, 1024)) }],
        size: "1536x1024",
      })),
    request(f) {
      const [r] = f.calls("POST", /images\/generations/);
      expect(r?.body).toMatchObject({
        model: "gpt-image-2.5-flare",
        size: "1536x1024",
        output_format: "png",
        n: 1,
      });
      expect(String((r?.body as { prompt?: string } | undefined)?.prompt)).toContain("Hero image for Brio");
    },
    contentType: "image/png",
    usd: 0.2,
  },
  {
    service: "openai-speech",
    model: "gpt-4o-mini-tts",
    kind: "voice",
    authed: (h) => h.authorization === `Bearer ${KEY}`,
    install: (f) => void f.on("POST", /^\/v1\/audio\/speech$/, () => file(mp3(3), "audio/mpeg")),
    request(f) {
      expect(f.calls("POST", /audio\/speech/)[0]?.body).toMatchObject({
        model: "gpt-4o-mini-tts",
        input: SPOKEN,
        voice: "alloy",
        response_format: "mp3",
      });
    },
    contentType: "audio/mpeg",
    usd: SPOKEN.length * 0.00003,
  },
  {
    service: "gemini-video",
    model: "gemini-omni-1.1-flash",
    kind: "video",
    authed: (h) => h["x-goog-api-key"] === KEY,
    install(f) {
      f.on("POST", /^\/v1beta\/interactions$/, () => ({
        id: "v1_1",
        status: "completed",
        steps: [
          {
            type: "model_output",
            content: [
              {
                type: "video",
                mime_type: "video/mp4",
                uri: "https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media",
              },
            ],
          },
        ],
      }))
        .on("GET", /^\/v1beta\/files\/abc$/, (_r, n) => ({ state: n === 0 ? "PROCESSING" : "ACTIVE" }))
        .on("GET", /^\/v1beta\/files\/abc:download/, (r) =>
          r.headers["x-goog-api-key"] === KEY ? file(mp4(8), "video/mp4") : new Response("", { status: 403 }),
        );
    },
    request(f) {
      expect(f.calls("POST", /interactions/)[0]?.body).toMatchObject({
        model: "gemini-omni-1.1-flash",
        response_format: { type: "video", aspect_ratio: "16:9", resolution: "720p", delivery: "uri" },
        store: false,
      });
      expect(f.calls("GET", /files\/abc$/).length).toBe(2);
    },
    contentType: "video/mp4",
    usd: 0.8,
  },
  {
    service: "gemini-image",
    model: "gemini-nano-banana-2.1",
    kind: "image",
    authed: (h) => h["x-goog-api-key"] === KEY,
    install: (f) =>
      void f.on("POST", /^\/v1beta\/interactions$/, () => ({
        id: "v1_2",
        status: "completed",
        steps: [
          {
            type: "model_output",
            content: [{ type: "image", mime_type: "image/png", data: b64(png(1536, 1024)) }],
          },
        ],
      })),
    request(f) {
      expect(f.calls("POST", /interactions/)[0]?.body).toMatchObject({
        response_format: { type: "image", aspect_ratio: "3:2", image_size: "2K" },
      });
    },
    contentType: "image/png",
    usd: 0.0504,
  },
  {
    service: "flux",
    model: "flux-3-image",
    kind: "image",
    authed: (h) => h["x-key"] === KEY,
    install(f, script) {
      f.on("POST", /^\/v1\/flux-3-image$/, () => ({
        id: "j1",
        polling_url: "https://api.bfl.ai/v1/get_result?id=j1",
        cost: 4,
      }))
        .on("GET", /^\/v1\/get_result/, (_r, n) =>
          script === "forever" || n === 0
            ? { id: "j1", status: "Pending" }
            : {
                id: "j1",
                status: "Ready",
                result: { sample: "https://delivery.eu1.bfl.ai/r/j1.png?sig=1" },
                cost: 4,
              },
        )
        .on("GET", /^\/r\/j1\.png/, () => file(png(1536, 1024), "application/octet-stream"));
    },
    request(f) {
      expect(f.calls("POST", /flux-3-image/)[0]?.body).toMatchObject({ width: 1536, height: 1024 });
    },
    contentType: "image/png",
    usd: 0.04,
  },
  {
    service: "runway",
    model: "gen4.5",
    kind: "video",
    authed: (h) => h.authorization === `Bearer ${KEY}` && h["x-runway-version"] === "2024-11-06",
    install(f, script) {
      f.on("POST", /^\/v1\/text_to_video$/, () => ({ id: "t1" }))
        .on("GET", /^\/v1\/tasks\/t1$/, (_r, n) =>
          script === "forever" || n === 0
            ? { id: "t1", status: n === 0 ? "THROTTLED" : "RUNNING", progress: 0.4 }
            : {
                id: "t1",
                status: "SUCCEEDED",
                output: ["https://cdn.runway.test/v/t1.mp4"],
                cost: { credits: 60 },
              },
        )
        .on("DELETE", /^\/v1\/tasks\/t1$/, () => new Response(null, { status: 204 }))
        .on("GET", /^\/v\/t1\.mp4/, () => file(mp4(5), "video/mp4"));
    },
    request(f) {
      expect(f.calls("POST", /text_to_video/)[0]?.body).toMatchObject({
        model: "gen4.5",
        ratio: "1280:720",
        duration: 8,
      });
    },
    contentType: "video/mp4",
    usd: 0.6,
    cancelCall: { method: "DELETE", path: /\/v1\/tasks\/t1$/ },
  },
  {
    service: "luma",
    model: "ray-3.2",
    kind: "video",
    authed: (h) => h.authorization === `Bearer ${KEY}`,
    install(f, script) {
      f.on("POST", /^\/v1\/generations$/, () => ({ id: "g1", state: "queued" }))
        .on("GET", /^\/v1\/generations\/g1$/, (_r, n) =>
          script === "forever" || n === 0
            ? { id: "g1", state: "processing" }
            : {
                id: "g1",
                state: "completed",
                output: [{ type: "video", url: "https://storage.luma.test/g1.mp4" }],
              },
        )
        .on("GET", /^\/g1\.mp4/, () => file(mp4(10), "video/mp4"));
    },
    request(f) {
      expect(f.calls("POST", /generations$/)[0]?.body).toMatchObject({
        model: "ray-3.2",
        type: "video",
        aspect_ratio: "16:9",
        video: { resolution: "720p", duration: "10s" },
      });
    },
    contentType: "video/mp4",
    usd: 0.9,
  },
  {
    service: "kling",
    model: "kling-4.0",
    kind: "video",
    authed: (h) => h.authorization === `Bearer ${KEY}`,
    install(f, script) {
      f.on("POST", /^\/text-to-video\/kling-4\.0$/, () => ({
        code: 0,
        data: { id: "k1", status: "submitted" },
      }))
        .on("GET", /^\/tasks\?task_ids=k1/, (_r, n) => ({
          code: 0,
          data: {
            result: [
              script === "forever" || n === 0
                ? { id: "k1", status: "processing" }
                : {
                    id: "k1",
                    status: "succeeded",
                    outputs: [{ type: "video", url: "https://cdn.kling.test/k1.mp4", duration: "8" }],
                    billing: [{ charge_type: "cash", amount: "1.2", currency: "USD" }],
                  },
            ],
          },
        }))
        .on("GET", /^\/k1\.mp4/, () => file(mp4(8), "video/mp4"));
    },
    request(f) {
      expect(f.calls("POST", /text-to-video/)[0]?.body).toMatchObject({
        settings: { duration: 8, resolution: "1080p", aspect_ratio: "16:9" },
      });
    },
    contentType: "video/mp4",
    usd: 1.2,
  },
  {
    service: "elevenlabs",
    model: "eleven_flash_v2_5",
    kind: "voice",
    authed: (h) => h["xi-api-key"] === KEY,
    install: (f) =>
      void f.on("POST", /^\/v1\/text-to-speech\/[\w-]+\?output_format=mp3_44100_128$/, () =>
        file(mp3(3), "audio/mpeg", { "character-cost": "25", "request-id": "req_1" }),
      ),
    request(f) {
      expect(f.calls("POST", /text-to-speech/)[0]?.body).toEqual({
        text: SPOKEN,
        model_id: "eleven_flash_v2_5",
      });
    },
    contentType: "audio/mpeg",
    usd: 25 * 0.00008,
  },
  {
    service: "ideogram",
    model: "ideogram-4-5",
    kind: "image",
    authed: (h) => h["api-key"] === KEY,
    install: (f) =>
      void f
        .on("POST", /^\/v2\/image\/generate\/ideogram-4-5$/, () => ({
          generation_id: "gen1",
          data: [
            {
              url: "https://ideogram.test/api/images/gen1.png",
              is_image_safe: true,
              resolution: "1536x1024",
            },
          ],
          usage_cost_usd_micros: 60_000,
        }))
        .on("GET", /^\/api\/images\/gen1\.png/, () => file(png(1536, 1024), "image/png")),
    request(f) {
      expect(f.calls("POST", /generate/)[0]?.body).toMatchObject({ size: "1536x1024", num_images: 1 });
    },
    contentType: "image/png",
    usd: 0.06,
  },
  {
    service: "recraft",
    model: "recraftv4_1",
    kind: "image",
    authed: (h) => h.authorization === `Bearer ${KEY}`,
    install: (f) =>
      void f.on("POST", /^\/v1\/images\/generations$/, () => ({
        created: 1,
        credits: 35,
        data: [{ image_id: "i1", b64_json: b64(png(1536, 1024)) }],
      })),
    request(f) {
      expect(f.calls("POST", /images\/generations/)[0]?.body).toMatchObject({
        model: "recraftv4_1",
        size: "3:2",
        response_format: "b64_json",
        image_format: "png",
      });
    },
    contentType: "image/png",
    usd: 0.035,
  },
];

const PATHS: Record<Kind, string> = {
  image: "public/hero.png",
  video: "public/teaser.mp4",
  voice: "public/voiceover.mp3",
};

function inputFor(kind: Kind): RunInput {
  const base = helloInput();
  const spec =
    kind === "image"
      ? { formats: ["png"], width: 1536, height: 1024 }
      : kind === "video"
        ? { formats: ["mp4"], aspect: 16 / 9, maxDurationS: 8 }
        : { formats: ["mp3"], maxDurationS: 30 };
  return {
    ...base,
    taskType: kind === "voice" ? "media.voice" : kind === "video" ? "media.video" : "media.image",
    contract: {
      objective:
        kind === "voice" ? "Record the voiceover" : `Hero ${kind === "video" ? "teaser" : "image"} for Brio`,
      inputs: kind === "voice" ? [{ kind: "file", ref: "copy/voiceover.md" }] : [],
      outputs: [
        { kind: kind === "voice" ? "audio" : kind, description: "for the landing page", path: PATHS[kind] },
      ],
      acceptance: [{ kind: "media_spec", hard: true, params: spec }],
      constraints: ["calm, dark background"],
      sensitivity: "internal",
    },
    limits: { maxCostUsd: 5, maxMinutes: 10, maxTurns: 10 },
  };
}

function setup(c: MediaCase, script: "done" | "forever" = "done") {
  const fake = new FakeService();
  c.install(fake, script);
  const sv = registry().service(c.service);
  if (!sv) throw new Error(`no service ${c.service}`);
  const config: AgentConfig = {
    agentId: "agent-1",
    name: "Media one",
    model: c.model,
    rolePrompt: "",
    connector: { registryKey: sv.connector, serviceKey: c.service, service: sv, settings: {}, baseUrl: "" },
    price: null,
    unitPrice:
      sv.pricing.usdPerUnit !== undefined ? { unit: sv.pricing.unit, usd: sv.pricing.usdPerUnit } : null,
    options: { pollMs: 5 },
  };
  const events: AdapterEvent[] = [];
  const controller = new AbortController();
  const ctx: RunContext = {
    credential: secret(KEY),
    emit: (e) => events.push(e),
    signal: controller.signal,
    sandbox: {
      available: true,
      readFile: async (p) => (p === "copy/voiceover.md" ? SCRIPT : Promise.reject(new Error("no such file"))),
      writeFile: async () => {},
      listFiles: async () => [],
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      spawn: () => {
        throw new Error("no spawn");
      },
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    fetch: fake.fetch,
  };
  const adapter = ADAPTERS[sv.adapter] as AgentAdapter;
  return { fake, config, ctx, events, controller, adapter, sv, input: inputFor(c.kind) };
}

/** Hosts that belong to the vendor's API (the key goes there and only there). */
const apiHost = (sv: { baseUrl: string }) => new URL(sv.baseUrl).host;

describe("media models: the contract", () => {
  it("covers every media service in the registry, each narrowed to the task types it makes", () => {
    const media = Object.entries(registry().services).filter(([, s]) => s.kind === "media");
    expect(CASES.map((c) => c.service).sort()).toEqual(media.map(([k]) => k).sort());
    for (const [k, s] of media) {
      expect(ADAPTERS[s.adapter], k).toBeDefined();
      expect(s.taskTypes?.length, k).toBeGreaterThan(0);
    }
  });

  for (const c of CASES) {
    describe(c.service, () => {
      it("checks the key for free (or says the first run will)", async () => {
        const s = setup(c);
        const health = new FakeService();
        if (s.sv.health)
          health.on(s.sv.health.method, /.*/, (r) =>
            c.authed(r.headers) ? {} : new Response("{}", { status: 401 }),
          );
        expect((await s.adapter.healthCheck(s.config.connector, { ...s.ctx, fetch: health.fetch })).ok).toBe(
          true,
        );
        if (s.sv.health) {
          const bad = await s.adapter.healthCheck(s.config.connector, {
            ...s.ctx,
            fetch: health.fetch,
            credential: secret("wrong-key-value-0123456789"),
          });
          expect(bad).toMatchObject({ ok: false, code: "auth" });
        }
      });

      it("makes the asked-for media, places it at the output path and meters it", async () => {
        const s = setup(c);
        const res = await s.adapter.run(s.input, s.config, s.ctx);
        expect(res.status, res.error).toBe("completed");
        c.request(s.fake);
        expect(res.files).toHaveLength(1);
        const f = res.files?.[0];
        expect(f).toMatchObject({
          path: PATHS[c.kind],
          contentType: c.contentType,
          name: PATHS[c.kind].split("/").pop(),
        });
        expect(f?.bytes.length).toBeGreaterThan(0);
        expect(s.events).toContainEqual({ kind: "file_edit", path: PATHS[c.kind], op: "create" });
        const usd = s.events.reduce((t, e) => t + (e.kind === "cost" ? e.usd : 0), 0);
        expect(usd).toBeCloseTo(c.usd, 6);
        expect(res.usage.usd).toBeCloseTo(c.usd, 6);
        // The key goes to the vendor's API and nowhere else, and never into what the run emits.
        for (const r of s.fake.requests) {
          const sent = JSON.stringify(r.headers).includes(KEY);
          if (new URL(r.url).host === apiHost(s.sv)) expect(c.authed(r.headers), r.url).toBe(true);
          else expect(sent, `key sent to ${r.url}`).toBe(false);
        }
        expect(JSON.stringify(s.events)).not.toContain(KEY);
        expect(JSON.stringify({ ...res, files: [] })).not.toContain(KEY);
      });

      if (c.cancelCall) {
        it("cancels the job at the vendor when the run is cancelled", async () => {
          const s = setup(c, "forever");
          const run = s.adapter.run(s.input, s.config, s.ctx);
          await new Promise((r) => setTimeout(r, 50));
          s.controller.abort();
          const res = await run;
          expect(res.status).toBe("cancelled");
          expect(s.fake.calls(c.cancelCall!.method, c.cancelCall!.path).length).toBe(1);
        });
      }
    });
  }
});

describe("media: refusals and edges", () => {
  const image = CASES.find((c) => c.service === "openai-image") as MediaCase;
  const voice = CASES.find((c) => c.service === "elevenlabs") as MediaCase;

  it("fails on a moderation refusal without retrying it", async () => {
    const s = setup({
      ...image,
      install: (f) =>
        void f.on(
          "POST",
          /images\/generations/,
          () =>
            new Response(
              JSON.stringify({
                error: {
                  type: "image_generation_user_error",
                  code: "moderation_blocked",
                  message: "blocked",
                },
              }),
              { status: 400 },
            ),
        ),
    });
    const res = await s.adapter.run(s.input, s.config, s.ctx);
    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/blocked/);
    expect(s.fake.calls("POST", /images\/generations/)).toHaveLength(1);
  });

  it("will not speak the instructions: a voice task with no script fails and says why", async () => {
    const s = setup(voice);
    const res = await s.adapter.run(
      {
        ...s.input,
        contract: { ...s.input.contract, inputs: [], objective: "Record a voiceover for the launch" },
      },
      s.config,
      s.ctx,
    );
    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/nothing to speak/);
    expect(s.fake.requests).toHaveLength(0);
  });

  it("speaks a quoted line from the objective when there is no script file", async () => {
    const s = setup(voice);
    const res = await s.adapter.run(
      {
        ...s.input,
        contract: { ...s.input.contract, inputs: [], objective: 'Say "Welcome to Brio." in a calm voice' },
      },
      s.config,
      s.ctx,
    );
    expect(res.status, res.error).toBe("completed");
    expect(s.fake.calls("POST", /text-to-speech/)[0]?.body).toMatchObject({ text: "Welcome to Brio." });
  });

  it("stops a job that costs more than the limit", async () => {
    const runway = CASES.find((c) => c.service === "runway") as MediaCase;
    const s = setup(runway);
    const res = await s.adapter.run(
      { ...s.input, limits: { ...s.input.limits, maxCostUsd: 0.1 } },
      s.config,
      s.ctx,
    );
    expect(res.status).toBe("limit_exceeded");
  });

  it("reports a vendor failure with its reason", async () => {
    const luma = CASES.find((c) => c.service === "luma") as MediaCase;
    const s = setup({
      ...luma,
      install: (f) =>
        void f
          .on("POST", /generations$/, () => ({ id: "g1", state: "queued" }))
          .on("GET", /generations\/g1/, () => ({
            id: "g1",
            state: "failed",
            failure_code: "content_moderated",
          })),
    });
    const res = await s.adapter.run(s.input, s.config, s.ctx);
    expect(res.status).toBe("failed");
    expect(res.error).toBe("content_moderated");
  });
});

describe("media: shapes", () => {
  it("reads the shape a media_spec check asks for", () => {
    expect(mediaShape(inputFor("image"))).toEqual({
      width: 1536,
      height: 1024,
      aspect: 1.5,
      formats: ["png"],
    });
    expect(mediaShape(inputFor("video"))).toMatchObject({ aspect: 16 / 9, durationS: 8, formats: ["mp4"] });
  });

  it("asks OpenAI for an exact size it allows, else the nearest preset", () => {
    expect(openaiImageSize({ width: 1920, height: 1080, formats: [] })).toBe("1920x1088");
    expect(openaiImageSize({ width: 64, height: 64, aspect: 1, formats: [] })).toBe("1024x1024");
    expect(openaiImageSize({ aspect: 0.6, formats: [] })).toBe("1024x1536");
    expect(openaiImageSize({ formats: [] })).toBe("auto");
  });

  it("picks the closest supported ratio", () => {
    expect(closestRatio(16 / 9, ["1:1", "16:9", "9:16"])).toBe("16:9");
    expect(closestRatio(1.4, ["1280:720", "720:1280", "960:960"])).toBe("1280:720");
    expect(closestRatio(undefined, ["4:3", "1:1"])).toBe("4:3");
  });

  it("turns a markdown script into speakable text", () => {
    expect(scriptOf(SCRIPT)).toBe(SPOKEN);
    expect(scriptOf("---\ntitle: x\n---\n<!-- note -->\nHello *there*.")).toBe("Hello there.");
  });
});
