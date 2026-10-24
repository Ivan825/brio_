#!/usr/bin/env node
// Smoke test for a self-hosted Brio (docs/SELF_HOST.md §Verify). Through the public entry point only, it signs in
// with an emailed link (read from the API's log, as on a server without email), creates a workspace, connects a fake
// OpenAI-compatible vendor, plans a mission with one code task, approves it, and follows the live event stream until
// the task's check — run in a sandbox container by the runner — has passed and the mission is done.
//
//   BRIO_ALLOW_PRIVATE_URLS=true in .env (the fake vendor runs on this machine), then: node smoke.mjs
//
// Leaves a "Smoke" workspace behind; nothing else.
import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.BRIO_URL ?? "http://localhost:8080").replace(/\/+$/, "");
const VENDOR_PORT = Number(process.env.SMOKE_VENDOR_PORT ?? 4300);
const VENDOR_URL = process.env.SMOKE_VENDOR_URL ?? `http://host.docker.internal:${VENDOR_PORT}/v1`;
const EMAIL = process.env.SMOKE_EMAIL ?? `smoke-${Date.now()}@example.com`;
const deadline = Date.now() + Number(process.env.SMOKE_TIMEOUT_MS ?? 300_000);

const step = (what) => console.log(`· ${what}`);
const fail = (why) => {
  console.error(`✗ ${why}`);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cookies = new Map();
let workspaceId = null;
async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    redirect: "manual",
    headers: {
      origin: BASE,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
      ...(workspaceId ? { "x-brio-workspace": workspaceId } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    cookies.set(pair.slice(0, i), pair.slice(i + 1));
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (res.status >= 400) fail(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return json;
}

// The fake vendor plans "Ship the health file" as one code task (write health.txt, checked by `test -f`).
const vendor = spawn(process.execPath, [join(here, "../../apps/web/e2e/fake-vendor.mjs")], {
  env: { ...process.env, FAKE_VENDOR_PORT: String(VENDOR_PORT) },
  stdio: "ignore",
});
process.on("exit", () => vendor.kill());
for (let i = 0; ; i++) {
  const ok = await fetch(`http://127.0.0.1:${VENDOR_PORT}/health`).then(
    (r) => r.ok,
    () => false,
  );
  if (ok) break;
  if (i > 50) fail("the fake vendor did not start");
  await sleep(100);
}

step(`sign in as ${EMAIL}`);
await call("POST", "/api/auth/sign-in/magic-link", { email: EMAIL, callbackURL: "/" });
let link = null;
for (let i = 0; i < 30 && !link; i++) {
  const logs = execFileSync("docker", ["compose", "logs", "--no-log-prefix", "api"], {
    cwd: here,
  }).toString();
  for (const line of logs.split("\n")) {
    if (!line.includes(EMAIL) || !line.includes("magic-link/verify")) continue;
    try {
      link = JSON.parse(line).mail?.link ?? link;
    } catch {}
  }
  if (!link) await sleep(500);
}
if (!link) fail("no sign-in link in the API's log");
const u = new URL(link);
await call("GET", `${u.pathname}${u.search}`);
const session = await call("GET", "/api/auth/get-session");
if (!session?.user) fail("signed-in session not found");

step("create a workspace, a connector and an agent");
workspaceId = (await call("POST", "/v1/workspaces", { name: "Smoke" })).workspace.id;
const connector = (
  await call("POST", "/v1/connectors", {
    registryKey: "litellm",
    baseUrl: VENDOR_URL,
    apiKey: "smoke-proxy-key-0001",
  })
).connector;
await call("POST", "/v1/agents", { connectorId: connector.id, name: "coder", model: "fake-model" });

step("plan a mission and approve it");
const mission = (await call("POST", "/v1/missions", { goal: "Ship the health file" })).mission;
let plan = null;
while (!plan && Date.now() < deadline) {
  const { plans } = await call("GET", `/v1/missions/${mission.id}/plans`);
  plan = plans.find((p) => p.status === "proposed") ?? null;
  if (!plan) await sleep(500);
}
if (!plan) fail("no plan was proposed");
await call("POST", `/v1/missions/${mission.id}/plans/${plan.version}/approve`);

step("follow the live events until the mission ends");
const res = await fetch(`${BASE}/v1/missions/${mission.id}/events`, {
  headers: {
    accept: "text/event-stream",
    cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    "x-brio-workspace": workspaceId,
  },
  signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
});
if (!res.ok || !res.body) fail(`event stream → ${res.status}`);
const seen = [];
let buffer = "";
let end = null;
const decoder = new TextDecoder();
try {
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let i = buffer.indexOf("\n\n");
    while (i >= 0) {
      const frame = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      if (data) {
        const e = JSON.parse(data);
        seen.push(e);
        if (["attempt.started", "check.result", "mission.done", "mission.failed"].includes(e.type))
          console.log(`  ${e.type}${e.payload?.passed !== undefined ? ` passed=${e.payload.passed}` : ""}`);
        if (e.type === "mission.done" || e.type === "mission.failed") end = e;
      }
      i = end ? -1 : buffer.indexOf("\n\n");
    }
    if (end) break;
  }
} catch (err) {
  if (!end) fail(`event stream ended without the mission ending: ${err.message}`);
}
if (end?.type !== "mission.done")
  fail(`mission ended as ${end?.type ?? "unknown"}: ${JSON.stringify(end?.payload ?? {})}`);
const started = seen.find((e) => e.type === "attempt.started");
const checks = seen.filter((e) => e.type === "check.result");
if (!started) fail("no attempt started");
if (!checks.length || !checks.every((c) => c.payload?.passed))
  fail("the task's check did not pass in its sandbox");
console.log(
  `✓ Brio works at ${BASE}: signed in, planned, ran a sandboxed task, checked it, streamed ${seen.length} events.`,
);
process.exit(0);
