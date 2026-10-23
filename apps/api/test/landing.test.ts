// M6 acceptance: "Landing page + hero image + 30-s voiceover" across at least three vendors — a model API (OpenAI or
// Anthropic, as the router picks) builds the page and writes the voiceover script, FLUX (Black Forest Labs) makes the
// hero image and ElevenLabs reads that script. Each result passes its own checks (tests, media specs), the branches integrate, and the page's tests pass on
// the merged result with the generated files in place. Vendors are fakes built from their documented wire formats.
// Needs Postgres and Docker.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { dockerAvailable } from "@brio/runner";
import { and, eq, gt } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";
import { type CallInfo, type Reply, ScriptedVendors, taskTitle } from "./vendors";

const hasDocker = await dockerAvailable();
const key = (...p: string[]) => [...p, "0123456789abcdefghijklmnop"].join("-");
const OPENAI = key("sk", "test");
const ANTHROPIC = key("sk", "ant", "test");
const BFL = key("bfl", "test");
const ELEVEN = key("xi", "test");

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const PNG = Uint8Array.from([
  0x89,
  ..."PNG\r\n\x1a\n".split("").map((c) => c.charCodeAt(0)),
  ...be32(13),
  ..."IHDR".split("").map((c) => c.charCodeAt(0)),
  ...be32(1536),
  ...be32(1024),
  8,
  6,
  0,
  0,
  0,
]);
/** 30 s of 128 kb/s MP3 (a frame header and the rest of the bytes, as a duration probe reads it). */
const MP3 = Uint8Array.from([0xff, 0xfb, 0x90, 0x00, ...new Array(30 * 16_000 - 4).fill(0)]);

const SCRIPT = "Meet Brio. One goal, many agents, one verified result. Start your first mission today.";

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Brio</title></head>
<body>
  <img src="public/hero.png" alt="Agents working together" width="1536" height="1024">
  <h1>One goal. Many agents. One result.</h1>
  <audio controls src="public/voiceover.mp3"></audio>
</body></html>
`;
const PAGE_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
test("the page shows the hero image and plays the voiceover", () => {
  assert.match(html, /<img[^>]+src="public\\/hero.png"[^>]+alt="[^"]+"/);
  assert.match(html, /<audio[^>]+src="public\\/voiceover.mp3"/);
});
test("once integrated, the generated files are in place", () => {
  if (process.env.BRIO_PAGE_ONLY) return;
  if (!existsSync(new URL("../public/hero.png", import.meta.url))) return;
  assert.ok(existsSync(new URL("../public/voiceover.mp3", import.meta.url)));
});
`;

function script(call: CallInfo): Reply {
  const title = taskTitle(call.body);
  const done = /tool_result|function_call_output/.test(call.body) && call.turn > 1;
  if (done) return { text: `Done: ${title}` };
  switch (title) {
    case "Build the landing page":
      return {
        tools: [
          { name: "write_file", args: { path: "index.html", content: PAGE } },
          { name: "write_file", args: { path: "check/page.test.mjs", content: PAGE_TEST } },
        ],
      };
    case "Write the voiceover script":
      return {
        tools: [
          { name: "write_file", args: { path: "copy/voiceover.md", content: `# Voiceover\n\n${SCRIPT}\n` } },
        ],
      };
    default:
      return { text: `unexpected: ${title}` };
  }
}

/** FLUX and ElevenLabs as documented (docs/vendors/media.md §3, §7), around the scripted model APIs. */
function media(models: ScriptedVendors) {
  const spoken: string[] = [];
  let polls = 0;
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const fetch = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const h = (init.headers ?? {}) as Record<string, string>;
    if (url.host === "api.bfl.ai") {
      if (h["x-key"] !== BFL) return json({ detail: "Invalid key" }, 403);
      if (url.pathname === "/v1/credits") return json({ credits: 100 });
      if (url.pathname === "/v1/flux-3-image")
        return json({ id: "j1", polling_url: "https://api.bfl.ai/v1/get_result?id=j1", cost: 4 });
      if (url.pathname === "/v1/get_result")
        return json(
          polls++ < 1
            ? { id: "j1", status: "Pending" }
            : {
                id: "j1",
                status: "Ready",
                result: { sample: "https://delivery.eu1.bfl.ai/r/j1.png?sig=x" },
                cost: 4,
              },
        );
    }
    if (url.host === "delivery.eu1.bfl.ai")
      return h["x-key"] ? json({}, 400) : new Response(PNG, { headers: { "content-type": "image/png" } });
    if (url.host === "api.elevenlabs.io") {
      if (h["xi-api-key"] !== ELEVEN) return json({ detail: { status: "invalid_api_key" } }, 401);
      if (url.pathname === "/v1/user") return json({ subscription: {} });
      if (url.pathname.startsWith("/v1/text-to-speech/")) {
        spoken.push((JSON.parse(String(init.body)) as { text: string }).text);
        return new Response(MP3, {
          headers: { "content-type": "audio/mpeg", "character-cost": String(SCRIPT.length) },
        });
      }
    }
    return models.fetch(input, init);
  };
  return { fetch, spoken };
}

const task = (o: {
  key: string;
  type: string;
  title: string;
  objective: string;
  outputs: Array<{ kind: string; description: string; path?: string }>;
  acceptance: unknown[];
  footprint: string[];
  inputs?: Array<{ kind: string; ref: string }>;
  dependsOn?: string[];
}) => ({
  key: o.key,
  type: o.type,
  title: o.title,
  contract: {
    objective: o.objective,
    inputs: o.inputs ?? [],
    outputs: o.outputs,
    acceptance: o.acceptance,
    constraints: [],
    expectedFootprint: { paths: o.footprint },
    sensitivity: "internal",
  },
  dependsOn: o.dependsOn ?? [],
  suggestedMode: "single",
});

const PLAN = {
  tasks: [
    task({
      key: "page",
      type: "code.frontend_ui",
      title: "Build the landing page",
      objective: "A landing page that shows the hero image and plays the voiceover, with a test",
      outputs: [{ kind: "diff", description: "index.html and its test" }],
      acceptance: [
        { kind: "tests", command: "node --test 'check/*.test.mjs'", hard: true },
        { kind: "diff_scope", hard: true },
      ],
      footprint: ["index.html", "check/**"],
    }),
    task({
      key: "script",
      type: "write.marketing_copy",
      title: "Write the voiceover script",
      objective: "A 30-second voiceover script for the landing page",
      outputs: [{ kind: "file", description: "the script", path: "copy/voiceover.md" }],
      acceptance: [{ kind: "diff_scope", hard: true }],
      footprint: ["copy/**"],
    }),
    task({
      key: "hero",
      type: "media.image",
      title: "Make the hero image",
      objective: "A calm hero image of agents working together, dark background",
      outputs: [{ kind: "image", description: "the hero image", path: "public/hero.png" }],
      acceptance: [
        { kind: "media_spec", hard: true, params: { formats: ["png"], width: 1536, height: 1024 } },
      ],
      footprint: ["public/hero.png"],
    }),
    task({
      key: "voice",
      type: "media.voice",
      title: "Record the voiceover",
      objective: "Read the voiceover script in a warm voice",
      inputs: [{ kind: "file", ref: "copy/voiceover.md" }],
      outputs: [{ kind: "audio", description: "the voiceover", path: "public/voiceover.mp3" }],
      acceptance: [
        { kind: "media_spec", hard: true, params: { formats: ["mp3"], minDurationS: 25, maxDurationS: 32 } },
      ],
      footprint: ["public/voiceover.mp3"],
      dependsOn: ["script"],
    }),
  ],
  assumptions: [],
  questions: [],
};

describe.skipIf(!hasTestDatabase || !hasDocker)(
  "M6 acceptance: landing page + hero image + 30-s voiceover",
  () => {
    const models = new ScriptedVendors(script);
    const vendors = media(models);
    let h: Harness;
    let c: Client;
    let dir: string;

    beforeAll(async () => {
      h = await startHarness({ fetch: vendors.fetch });
      c = new Client(h);
      await c.signIn("landing@example.com");
      await c.request("POST", "/v1/workspaces", { name: "Launch" });
      const price = { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null };
      const install = async (body: Record<string, unknown>) => {
        const r = await c.request("POST", "/v1/connectors", body);
        expect(r.statusCode, r.body).toBe(201);
        return r.json().connector.id as string;
      };
      const agent = async (connectorId: string, name: string, model: string, priced = true) => {
        const r = await c.request("POST", "/v1/agents", {
          connectorId,
          name,
          model,
          ...(priced ? { priceOverride: price } : {}),
        });
        expect(r.statusCode, r.body).toBe(201);
      };
      await agent(await install({ registryKey: "openai-api", apiKey: OPENAI }), "coder", "gpt-coder");
      await agent(await install({ registryKey: "claude-api", apiKey: ANTHROPIC }), "writer", "claude-writer");
      await agent(
        await install({ registryKey: "black-forest-labs-flux", apiKey: BFL }),
        "flux",
        "flux-3-image",
        false,
      );
      await agent(await install({ registryKey: "elevenlabs", apiKey: ELEVEN }), "voice", "eleven_v4", false);

      dir = mkdtempSync(join(tmpdir(), "brio-landing-"));
      writeFileSync(join(dir, "README.md"), "# Launch\n");
      const git = (...a: string[]) =>
        execFileSync("git", a, {
          cwd: dir,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@t",
          },
        });
      git("init", "-q", "-b", "main");
      git("add", ".");
      git("commit", "-q", "-m", "init");
    }, 120_000);
    afterAll(async () => {
      await h?.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("routes each piece to its specialist, verifies each result and integrates them", async () => {
      const p = await c.request("POST", "/v1/projects", {
        name: "launch",
        repoUrl: dir,
        defaultBranch: "main",
      });
      const m = await c.request("POST", "/v1/missions", {
        goal: "Landing page with a hero image and a 30-second voiceover",
        plan: PLAN,
        routing: { strategy: "learned" },
        projectId: p.json().project.id,
      });
      expect(m.statusCode, m.body).toBe(201);
      const id = m.json().mission.id as string;
      expect((await c.request("POST", `/v1/missions/${id}/plans/1/approve`)).statusCode).toBe(200);

      const until = Date.now() + 600_000;
      for (;;) {
        const [row] = await h.db.db.select().from(schema.missions).where(eq(schema.missions.id, id));
        if (row?.status === "done") break;
        if (row?.status === "failed" || Date.now() > until) {
          const ts = await h.db.db.select().from(schema.tasks).where(eq(schema.tasks.missionId, id));
          const at = await h.db.db.select().from(schema.attempts);
          throw new Error(
            `mission ${row?.status}: ${JSON.stringify(ts.map((t) => [t.key, t.status, t.blockedReason]))} ${JSON.stringify(at.map((a) => [a.status, a.exitReason]))}`,
          );
        }
        await new Promise((r) => setTimeout(r, 400));
      }

      const tasks = await h.db.db
        .select()
        .from(schema.tasks)
        .where(and(eq(schema.tasks.missionId, id), gt(schema.tasks.planVersion, 0)));
      const byKey = new Map(tasks.map((t) => [t.key, t]));
      const vendorOf = new Map<string, string>();
      for (const k of ["page", "script", "hero", "voice"]) {
        const t = byKey.get(k);
        expect(t?.status, k).toBe("done");
        const [a] = await h.db.db.select().from(schema.attempts).where(eq(schema.attempts.taskId, t!.id));
        const d = a?.dispatch as { agent: { connector: { presetKey?: string; serviceKey?: string } } };
        vendorOf.set(k, d.agent.connector.presetKey ?? d.agent.connector.serviceKey ?? "");
        const checks = (a?.checks as { items: { kind: string; status: string }[] } | undefined)?.items ?? [];
        expect(
          checks.every((i) => i.status === "passed"),
          `${k}: ${JSON.stringify(checks)}`,
        ).toBe(true);
      }
      // At least three vendors across code, image and voice: the media specialists by capability, the page and the
      // script by whichever model API the router picked.
      expect(vendorOf.get("hero")).toBe("flux");
      expect(vendorOf.get("voice")).toBe("elevenlabs");
      for (const k of ["page", "script"]) expect(["anthropic", "openai"]).toContain(vendorOf.get(k));
      expect(new Set(vendorOf.values()).size).toBeGreaterThanOrEqual(3);
      // The voice read the writer's script, not the task's instructions.
      expect(vendors.spoken).toEqual([SCRIPT]);

      // The integration merged all four and the page's tests passed with the files in place.
      const [integration] = await h.db.db
        .select()
        .from(schema.integrations)
        .where(eq(schema.integrations.missionId, id));
      expect(integration?.status).toBe("passed");
      expect(integration?.refs.map((r) => r.taskKey).sort()).toEqual(["hero", "page", "script", "voice"]);
      expect(integration?.checks.every((x) => x.passed)).toBe(true);

      const report = (await c.request("GET", `/v1/missions/${id}/report`)).json().report as {
        status: string;
        costUsd: number;
      };
      expect(report.status).toBe("done");
      // FLUX credits (4 at a cent) and ElevenLabs characters are in the mission's cost.
      expect(report.costUsd).toBeGreaterThan(0.04);
    }, 900_000);
  },
);
