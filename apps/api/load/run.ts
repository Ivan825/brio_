// Load test (M10, docs/LOAD_TEST.md): 125 missions at once, 4 tasks each (a mission runs at most 4 tasks in parallel),
// so 500 attempts in flight against a slow
// vendor, while people read the API and watch every mission's live events. The API and the runners run as their own
// processes, from their real entry points, as in production; this script is only their clients and the vendor.
// Measures API latency (SLO p95 < 300 ms) and event fan-out — from an event being written to a watching browser
// receiving it (SLO p95 < 1 s) — and fails if an SLO is missed or a mission does not finish.
//
//   TEST_DATABASE_URL=postgres://brio:brio@localhost:5433/brio pnpm --filter @brio/api load
//
// Knobs: LOAD_MISSIONS (125), LOAD_TASKS (4), LOAD_RUNNERS (8, 64 attempts each), LOAD_READERS (20),
// LOAD_VENDOR_MS (8000), LOAD_WEB (2 web processes and a worker; 0 for one process doing both), LOAD_PROFILE (a dir
// for the API processes' CPU profiles).
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "@brio/db";
import { createTestDb } from "@brio/db/testing";

const MISSIONS = Number(process.env.LOAD_MISSIONS ?? 125);
const TASKS = Number(process.env.LOAD_TASKS ?? 4);
const RUNNERS = Number(process.env.LOAD_RUNNERS ?? 8);
const PER_RUNNER = 64;
const READERS = Number(process.env.LOAD_READERS ?? 20);
const WEB = Number(process.env.LOAD_WEB ?? 2);
const VENDOR_MS = Number(process.env.LOAD_VENDOR_MS ?? 8000);
const SLO_API_P95_MS = 300;
const SLO_FANOUT_P95_MS = 1000;
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");

const pct = (xs: number[], p: number) => {
  if (!xs.length) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? Number.NaN;
};
const log = (s: string) => process.stdout.write(`${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The vendor: an OpenAI-compatible endpoint (as a LiteLLM proxy) that takes about VENDOR_MS to answer.
let inFlight = 0;
let peakInFlight = 0;
const vendor = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => {
    body += c;
  });
  req.on("end", async () => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "gpt-load" }] }));
    }
    inFlight++;
    peakInFlight = Math.max(peakInFlight, inFlight);
    await sleep(VENDOR_MS * (0.75 + Math.random() / 2));
    inFlight--;
    res.writeHead(200, { "content-type": "application/json", "x-litellm-response-cost": "0.0011" });
    res.end(
      JSON.stringify({
        id: `chatcmpl-${randomBytes(6).toString("hex")}`,
        object: "chat.completion",
        choices: [
          { index: 0, message: { role: "assistant", content: "Summary: done." }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1000, completion_tokens: 50 },
      }),
    );
  });
});
await new Promise<void>((r) => vendor.listen(0, "127.0.0.1", r));
const vendorUrl = `http://127.0.0.1:${(vendor.address() as AddressInfo).port}/v1`;

const db = await createTestDb();
const kek = randomBytes(32).toString("base64");
const shared = {
  ...process.env,
  NODE_ENV: "development",
  DATABASE_URL: db.url,
  BRIO_VAULT_LOCAL_KEK: kek,
  BRIO_ALLOW_PRIVATE_URLS: "true",
  LOG_LEVEL: "warn",
};
const children: ChildProcess[] = [];
const start = (cwd: string, env: Record<string, string>, profile = false) => {
  // LOAD_PROFILE=dir writes the API's CPU profile there (node --cpu-prof), to find what holds its event loop.
  const prof =
    profile && process.env.LOAD_PROFILE ? ["--cpu-prof", `--cpu-prof-dir=${process.env.LOAD_PROFILE}`] : [];
  const child = spawn(process.execPath, [...prof, "--import", "tsx", "src/main.ts"], {
    cwd,
    env: { ...shared, ...env },
    stdio: ["ignore", "ignore", "inherit"],
  });
  children.push(child);
  return child;
};
const stopAll = () => {
  // SIGINT lets the API write its CPU profile on the way out.
  for (const c of children) c.kill("SIGINT");
};
process.on("exit", stopAll);

// The API as deployed at scale: WEB processes serving requests (BRIO_API_ROLE=web) and one worker running missions;
// LOAD_WEB=0 runs one process doing both.
const port = () => 40_000 + Math.floor(Math.random() * 10_000);
const webPorts = Array.from({ length: Math.max(1, WEB) }, port);
const APP_URL = `http://127.0.0.1:${webPorts[0]}`;
const apiEnv = {
  HOST: "127.0.0.1",
  APP_URL,
  BETTER_AUTH_SECRET: randomBytes(32).toString("base64"),
  BRIO_DEV_OUTBOX: "true",
  BRIO_PRICING_REFRESH_HOURS: "0",
  // Every simulated person shares one address here.
  BRIO_RATE_LIMIT_PER_MINUTE: "0",
};
const healthPorts = [...webPorts];
if (WEB === 0)
  start(join(repo, "apps/api"), { ...apiEnv, PORT: String(webPorts[0]), BRIO_API_ROLE: "all" }, true);
else {
  for (const p of webPorts)
    start(join(repo, "apps/api"), { ...apiEnv, PORT: String(p), BRIO_API_ROLE: "web" }, true);
  const workerPort = port();
  healthPorts.push(workerPort);
  start(join(repo, "apps/api"), { ...apiEnv, PORT: String(workerPort), BRIO_API_ROLE: "worker" }, true);
}
const bases = webPorts.map((p) => `http://127.0.0.1:${p}`);
let next = 0;
// Sign-in stays on one process (the dev outbox holding the emailed link is in its memory).
let pinned: string | null = bases[0]!;
/** Round robin over the web processes, as a load balancer would. */
const pick = () => pinned ?? bases[next++ % bases.length]!;
const dirs: string[] = [];
for (let i = 0; i < RUNNERS; i++) {
  const dir = await mkdtemp(join(tmpdir(), "brio-load-runner-"));
  dirs.push(dir);
  start(join(repo, "apps/runner"), { BRIO_RUNNER_DIR: dir, BRIO_RUNNER_CONCURRENCY: String(PER_RUNNER) });
}
for (const p of healthPorts)
  for (let i = 0; ; i++) {
    if (
      await fetch(`http://127.0.0.1:${p}/health`).then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    if (i > 150) throw new Error("the API did not start");
    await sleep(200);
  }

// A person, signed in through the dev outbox.
let cookie = "";
let workspaceId = "";
async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${pick()}${path}`, {
    method,
    redirect: "manual",
    headers: {
      origin: APP_URL,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(workspaceId ? { "x-brio-workspace": workspaceId } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  for (const c of res.headers.getSetCookie()) cookie = [cookie, c.split(";")[0]].filter(Boolean).join("; ");
  const text = await res.text();
  if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
await call("POST", "/api/auth/sign-in/magic-link", { email: "load@example.com", callbackURL: "/" });
const { messages } = await call("GET", "/v1/dev/outbox?email=load%40example.com");
const link = new URL(messages.at(-1).link);
await call("GET", `${link.pathname}${link.search}`);
pinned = null;
workspaceId = (await call("POST", "/v1/workspaces", { name: "Load" })).workspace.id;
const connector = (
  await call("POST", "/v1/connectors", {
    registryKey: "litellm",
    baseUrl: vendorUrl,
    apiKey: "load-proxy-key-0001",
  })
).connector;
const agentId = (
  await call("POST", "/v1/agents", {
    connectorId: connector.id,
    name: "writer",
    model: "gpt-load",
    priceOverride: { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null },
  })
).agent.id;

const plan = (m: number) => ({
  tasks: Array.from({ length: TASKS }, (_, i) => ({
    key: `t${i}`,
    type: "write.summary",
    title: `Mission ${m} task ${i}`,
    contract: {
      objective: `Summarise part ${i}`,
      inputs: [],
      outputs: [{ kind: "report", description: "a summary" }],
      acceptance: [{ kind: "diff_scope", hard: true }],
      constraints: [],
      sensitivity: "internal",
    },
    dependsOn: [],
    suggestedMode: "single",
  })),
  assumptions: [],
  questions: [],
});

log(
  `load: ${MISSIONS} missions × ${TASKS} tasks; API ${WEB ? `${WEB} web + 1 worker` : "1 process"}, ${RUNNERS} runners (${PER_RUNNER} each); ${READERS} readers; vendor ~${VENDOR_MS} ms`,
);
const missionIds: string[] = [];
for (let m = 0; m < MISSIONS; m++)
  missionIds.push(
    (
      await call("POST", "/v1/missions", {
        goal: `Load mission ${m}`,
        plan: plan(m),
        routing: { strategy: "single", agentId },
      })
    ).mission.id,
  );

// Every mission watched live, as a board in a browser would.
const fanout: number[] = [];
const fanoutByType = new Map<string, number[]>();
const streams = new AbortController();
const done = new Set<string>();
const opened = Date.now();
for (const id of missionIds)
  void (async () => {
    const res = await fetch(`${pick()}/v1/missions/${id}/events`, {
      headers: { cookie, "x-brio-workspace": workspaceId, accept: "text/event-stream" },
      signal: streams.signal,
    });
    if (!res.body) return;
    let buf = "";
    const dec = new TextDecoder();
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i = buf.indexOf("\n\n");
        while (i >= 0) {
          const data = buf
            .slice(0, i)
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("");
          buf = buf.slice(i + 2);
          if (data) {
            const e = JSON.parse(data) as { type: string; ts: string };
            const ts = new Date(e.ts).getTime();
            // Events written before the streams opened are a replay, not fan-out.
            if (ts >= opened) {
              const lag = Date.now() - ts;
              fanout.push(lag);
              fanoutByType.set(e.type, [...(fanoutByType.get(e.type) ?? []), lag]);
            }
            if (e.type === "mission.done" || e.type === "mission.failed") done.add(id);
          }
          i = buf.indexOf("\n\n");
        }
      }
    } catch {
      // aborted at the end
    }
  })();
await sleep(500);

// People reading while it runs.
const latency: number[] = [];
const byRoute = new Map<string, number[]>();
let reading = true;
const reads = [
  () => "/v1/missions",
  () => `/v1/missions/${missionIds[Math.floor(Math.random() * missionIds.length)]}`,
  () => "/v1/inbox",
  () => "/v1/scoreboard",
  () => "/v1/budgets",
];
const readers = Array.from({ length: READERS }, async () => {
  while (reading) {
    const path = reads[Math.floor(Math.random() * reads.length)]!();
    const t0 = performance.now();
    await call("GET", path).catch(() => undefined);
    const took = performance.now() - t0;
    latency.push(took);
    const route = path.replace(/[0-9a-f-]{36}/g, ":id");
    byRoute.set(route, [...(byRoute.get(route) ?? []), took]);
    await sleep(50);
  }
});

const pool = createDb(db.url, { max: 2 });
const started = Date.now();
await Promise.all(missionIds.map((id) => call("POST", `/v1/missions/${id}/plans/1/approve`)));
const approveMs = Date.now() - started;
const deadline = started + 10 * 60_000;
let peakRunning = 0;
while (done.size < missionIds.length && Date.now() < deadline) {
  const r = await pool.pool.query("select count(*)::int as n from attempts where status = 'running'");
  peakRunning = Math.max(peakRunning, r.rows[0].n);
  await sleep(250);
}
const elapsed = Date.now() - started;
reading = false;
await Promise.all(readers);
streams.abort();

const statuses = await pool.pool.query(
  "select status, count(*)::int as n from missions where workspace_id = $1 group by status",
  [workspaceId],
);
const round = (n: number) => Math.round(n);
const result = {
  missions: MISSIONS,
  attempts: MISSIONS * TASKS,
  peakRunningAttempts: peakRunning,
  peakVendorCallsInFlight: peakInFlight,
  missionStatuses: Object.fromEntries(statuses.rows.map((r) => [r.status, r.n])),
  approveAllMs: approveMs,
  wallClockMs: elapsed,
  api: {
    requests: latency.length,
    p50: round(pct(latency, 50)),
    p95: round(pct(latency, 95)),
    p99: round(pct(latency, 99)),
  },
  apiByRoute: Object.fromEntries(
    [...byRoute].map(([route, xs]) => [
      route,
      { n: xs.length, p50: round(pct(xs, 50)), p95: round(pct(xs, 95)) },
    ]),
  ),
  fanoutByType: Object.fromEntries(
    [...fanoutByType].map(([type, xs]) => [
      type,
      { n: xs.length, p50: round(pct(xs, 50)), p95: round(pct(xs, 95)) },
    ]),
  ),
  fanout: {
    events: fanout.length,
    p50: round(pct(fanout, 50)),
    p95: round(pct(fanout, 95)),
    p99: round(pct(fanout, 99)),
  },
};
log(JSON.stringify(result, null, 2));

const failures: string[] = [];
if (result.missionStatuses.done !== MISSIONS)
  failures.push(`only ${result.missionStatuses.done ?? 0} missions done`);
if (!(result.api.p95 < SLO_API_P95_MS)) failures.push(`API p95 ${result.api.p95} ms ≥ ${SLO_API_P95_MS} ms`);
if (!(result.fanout.p95 < SLO_FANOUT_P95_MS))
  failures.push(`fan-out p95 ${result.fanout.p95} ms ≥ ${SLO_FANOUT_P95_MS} ms`);
log(failures.length ? `✗ ${failures.join("; ")}` : "✓ SLOs met");

stopAll();
await sleep(4000);
await pool.close();
await db.drop();
vendor.close();
for (const d of dirs) await rm(d, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
