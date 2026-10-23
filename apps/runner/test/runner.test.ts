// M2 acceptance on real Docker: a model-API agent codes through sandbox file tools and its tests pass inside the
// sandbox; a CLI agent (through CliAdapterBase) produces a diff; cancel kills process and container within 10 s; a cost
// breach ends with limit_exceeded; secrets never reach events and secret-bearing output is quarantined; the reaper
// fails attempts whose runner died.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADAPTERS,
  type AgentAdapter,
  type AgentConfig,
  createCliAdapter,
  type Dispatch,
  EMPTY_BRIEF,
  redactingLogger,
} from "@brio/adapters";
import { chooseSandbox } from "@brio/core";
import { readEventsSince, schema } from "@brio/db";
import { createTestDb, hasTestDatabase, type TestDb } from "@brio/db/testing";
import { Ledger } from "@brio/governance";
import { registry } from "@brio/registry";
import { LocalKeyProvider, Redactor, Vault } from "@brio/vault";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { docker, dockerAvailable } from "../src/docker";
import { DEFAULT_IMAGES, ensureImage } from "../src/images";
import { enqueueAttempt, startQueue } from "../src/queue";
import { Runner, requestCancel } from "../src/runner";

const { agents, artifacts, attempts, blobs, connectors, missions, tasks, workspaces } = schema;
const hasDocker = await dockerAvailable();
const KEY = ["sk", "runner", "test", randomBytes(12).toString("hex")].join("-");
const g = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });

const fakeCli = createCliAdapter({
  key: "fake-cli",
  connector: "claude-code",
  vendorPreset: "anthropic",
  credentialEnv: ["FAKE_CLI_KEY"],
  egressHosts: [],
  image: "cli",
  promptVia: "stdin",
  reportsCost: true,
  argv: (_prompt, config) => [
    "env",
    `FAKE_CLI_MODE=${String(config.options?.mode ?? "normal")}`,
    "node",
    ".fake-cli.mjs",
  ],
  parse(e, state) {
    if (e.type === "start") state.sessionId = String(e.session);
    if (e.type === "text") return [{ kind: "message", role: "assistant", text: String(e.text) }];
    if (e.type === "tool") return [{ kind: "tool_call", name: String(e.name), args: e.args }];
    if (e.type === "usage") {
      state.usage = {
        inputTokens: Number(e.input),
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: Number(e.output),
        reasoningTokens: 0,
      };
      state.vendorCostUsd = Number(e.cost);
    }
    if (e.type === "result") {
      state.result = String(e.text);
      state.finished = true;
    }
    return [];
  },
});

/** A scripted vendor that codes through the sandbox tools: write the function and test, run the tests, answer. */
function codingVendor(): typeof fetch {
  const replies = [
    {
      calls: [
        {
          name: "write_file",
          args: {
            path: "math.js",
            content: "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n",
          },
        },
      ],
    },
    {
      calls: [
        {
          name: "write_file",
          args: {
            path: "math.test.js",
            content:
              'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sub } from "./math.js";\ntest("sub", () => assert.equal(sub(5, 3), 2));\n',
          },
        },
      ],
    },
    { calls: [{ name: "run_command", args: { command: "node --test" } }] },
    { text: "Added sub() with a unit test; node --test passes." },
  ];
  let i = 0;
  return (async () => {
    const r = replies[i++] ?? replies.at(-1)!;
    const message = r.calls
      ? {
          role: "assistant",
          content: null,
          tool_calls: r.calls.map((c, k) => ({
            id: `call_${i}_${k}`,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        }
      : { role: "assistant", content: r.text };
    return new Response(
      JSON.stringify({
        id: `c${i}`,
        choices: [{ message, finish_reason: r.calls ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 500, completion_tokens: 50 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

describe.skipIf(!hasTestDatabase || !hasDocker)("runner on Docker (M2 acceptance)", () => {
  let db: TestDb;
  let boss: PgBoss;
  let runner: Runner;
  let dir: string;
  let repo: string;
  let vault: Vault;
  const redactor = new Redactor();
  const logs: string[] = [];
  const ws = { id: "" };
  let missionId: string;
  let secretId: string;
  let fetchImpl: typeof fetch = codingVendor();

  beforeAll(async () => {
    await Promise.all([ensureImage(DEFAULT_IMAGES, "base"), ensureImage(DEFAULT_IMAGES, "proxy")]);
    db = await createTestDb();
    dir = await mkdtemp(join(tmpdir(), "brio-runner-it-"));
    // The fixture repo: an ES module with add(), a test script, and the fake CLI.
    repo = join(dir, "fixture");
    await mkdir(repo);
    g(repo, "init", "-q", "-b", "main");
    await writeFile(join(repo, "package.json"), '{"type":"module","scripts":{"test":"node --test"}}\n');
    await writeFile(join(repo, "math.js"), "export const add = (a, b) => a + b;\n");
    await copyFile(join(import.meta.dirname, "fixtures", "fake-cli.mjs"), join(repo, ".fake-cli.mjs"));
    g(repo, "add", ".");
    g(repo, "commit", "-q", "-m", "fixture");

    vault = new Vault(LocalKeyProvider.fromBase64(randomBytes(32).toString("base64")), redactor);
    const [w] = await db.db
      .insert(workspaces)
      .values({ name: "Runner", slug: `runner-${randomBytes(3).toString("hex")}` })
      .returning();
    ws.id = w!.id;
    const [m] = await db.db
      .insert(missions)
      .values({ workspaceId: ws.id, title: "M2", goal: "add sub()", status: "running" })
      .returning();
    missionId = m!.id;
    secretId = (await vault.put(db.db, { workspaceId: ws.id, label: "connector:test", value: KEY })).id;

    boss = await startQueue(db.url);
    const events = new (await import("@brio/db")).EventWriter(redactor);
    runner = new Runner({
      db: db.db,
      databaseUrl: db.url,
      boss,
      events,
      ledger: new Ledger(redactor),
      vault,
      redactor,
      fetch: ((u: string | URL, init?: RequestInit) => fetchImpl(u, init)) as typeof fetch,
      log: redactingLogger((_l, obj, msg) => logs.push(JSON.stringify({ ...obj, msg })), redactor),
      dir: join(dir, "runner"),
      images: DEFAULT_IMAGES,
      heartbeatMs: 300,
      reapEveryMs: 3_600_000,
      resolveAdapter: (k) =>
        (k === "fake-cli"
          ? fakeCli
          : k === "openai-compatible"
            ? ADAPTERS["openai-compatible"]
            : undefined) as AgentAdapter | undefined,
    });
    await runner.start();
  });

  afterAll(async () => {
    await runner?.stop();
    await boss?.stop({ graceful: false });
    await db?.drop();
    await rm(dir, { recursive: true, force: true });
  });

  async function queue(opts: {
    adapter: "fake-cli" | "openai-compatible";
    key: string;
    cliMode?: string;
    maxCostUsd?: number;
  }) {
    const preset = registry().preset(opts.adapter === "fake-cli" ? "anthropic" : "openai")!;
    const [c] = await db.db
      .insert(connectors)
      .values({
        workspaceId: ws.id,
        registryKey: preset.connector,
        displayName: "c",
        route: opts.adapter === "fake-cli" ? "cli" : "api",
        credentialRef: secretId,
        config: {},
      })
      .returning();
    const [a] = await db.db
      .insert(agents)
      .values({ workspaceId: ws.id, connectorId: c!.id, name: opts.adapter, model: "m" })
      .returning();
    const [t] = await db.db
      .insert(tasks)
      .values({
        workspaceId: ws.id,
        missionId,
        planVersion: 1,
        key: opts.key,
        type: "code.feature",
        title: "Add sub()",
        status: "running",
        contract: {
          objective: "Add sub() with a test",
          inputs: [],
          outputs: [{ kind: "diff", description: "sub and test" }],
          acceptance: [{ kind: "tests", command: "node --test", hard: true }],
          constraints: [],
          sensitivity: "internal",
        },
      })
      .returning();
    const agent: AgentConfig = {
      agentId: a!.id,
      name: opts.adapter,
      model: "m",
      rolePrompt: "",
      connector: {
        registryKey: preset.connector,
        presetKey: opts.adapter === "fake-cli" ? "anthropic" : "openai",
        preset,
        baseUrl: preset.baseUrl!,
        apiStyle: "chat",
      },
      price: { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null },
    };
    const route = opts.adapter === "fake-cli" ? "cli" : "api";
    const dispatch: Dispatch = {
      version: 1,
      adapterKey: opts.adapter,
      route,
      missionId,
      taskId: t!.id,
      taskKey: opts.key,
      connectorId: c!.id,
      credentialRef: secretId,
      input: {
        taskTitle: "Add sub()",
        taskType: "code.feature",
        instructions: "Add sub(a, b) to math.js with a node:test unit test, and make `node --test` pass.",
        contract: t!.contract,
        handoffs: [],
        brief: EMPTY_BRIEF,
        attachments: [],
        limits: { maxCostUsd: opts.maxCostUsd ?? 1, maxMinutes: 5, maxTurns: 8 },
        mcpServers: [],
      },
      agent,
      sandbox: chooseSandbox({
        route,
        taskType: "code.feature",
        agentSetting: "standard",
        vendorHosts: [],
        maxMinutes: 5,
      }),
      image: "base",
      repo: { url: repo, branch: "main" },
    };
    if (opts.cliMode) dispatch.agent.options = { mode: opts.cliMode };
    const [row] = await db.db
      .insert(attempts)
      .values({
        workspaceId: ws.id,
        taskId: t!.id,
        agentId: a!.id,
        role: "maker",
        status: "queued",
        dispatch: dispatch as never,
      })
      .returning();
    return row!.id;
  }

  const waitFor = async (id: string, ms = 120_000) => {
    const until = Date.now() + ms;
    for (;;) {
      const [a] = await db.db.select().from(attempts).where(eq(attempts.id, id));
      if (a && a.status !== "queued" && a.status !== "running") return a;
      if (Date.now() > until) throw new Error(`attempt ${id} still ${a?.status}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  it("an API model writes code and a test in its sandbox; the test passes there; the diff is an artifact", async () => {
    fetchImpl = codingVendor();
    const id = await queue({ adapter: "openai-compatible", key: "api-coder" });
    await enqueueAttempt(boss, id);
    const a = await waitFor(id);
    expect(a.status, a.exitReason ?? "").toBe("succeeded");
    expect(a.worktreeRef).toMatch(/^brio\/[0-9a-f]{8}\/api-coder\//);
    const events = await readEventsSince(db.db, missionId, 0);
    const mine = events.filter((e) => e.attemptId === id);
    const toolOutput = mine.filter(
      (e) => e.type === "attempt.message" && (e.payload as { role: string }).role === "tool",
    );
    expect(toolOutput.map((e) => (e.payload as { text: string }).text).join("\n")).toMatch(
      /exit 0[\s\S]*pass 1/,
    );
    expect(
      mine.filter((e) => e.type === "attempt.file_edit").map((e) => (e.payload as { path: string }).path),
    ).toEqual(expect.arrayContaining(["math.js", "math.test.js"]));
    const diff = (await db.db.select().from(artifacts).where(eq(artifacts.attemptId, id))).find(
      (x) => x.kind === "diff",
    )!;
    const [blob] = await db.db.select().from(blobs).where(eq(blobs.sha256, diff.sha256));
    expect(blob!.bytes.toString()).toContain("+export const sub = (a, b) => a - b;");
    expect(diff.meta).toMatchObject({
      files: expect.arrayContaining([expect.objectContaining({ path: "math.test.js", status: "added" })]),
    });
    // The container is gone after the run.
    expect((await docker(["ps", "-aq", "--filter", `label=brio.attempt=${id}`])).stdout.trim()).toBe("");
  });

  it("a CLI agent runs headless in the sandbox through CliAdapterBase and produces a diff", async () => {
    const id = await queue({ adapter: "fake-cli", key: "cli-coder" });
    await enqueueAttempt(boss, id);
    const a = await waitFor(id);
    expect(a.status, a.exitReason ?? "").toBe("succeeded");
    expect(a.costUsd).toBe(0.0123);
    expect(a.transcriptRef).toBe("fake-session-1");
    const types = (await readEventsSince(db.db, missionId, 0))
      .filter((e) => e.attemptId === id)
      .map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "attempt.started",
        "attempt.tool_call",
        "attempt.cost",
        "attempt.file_edit",
        "attempt.finished",
      ]),
    );
    const diff = (await db.db.select().from(artifacts).where(eq(artifacts.attemptId, id))).find(
      (x) => x.kind === "diff",
    );
    expect(diff).toBeDefined();
  });

  it("cancel mid-run kills the process and the container within 10 s", async () => {
    const id = await queue({ adapter: "fake-cli", key: "cli-slow", cliMode: "slow" });
    await enqueueAttempt(boss, id);
    for (let i = 0; i < 300; i++) {
      const [a] = await db.db.select().from(attempts).where(eq(attempts.id, id));
      const evs = await readEventsSince(db.db, missionId, 0);
      if (a?.status === "running" && evs.some((e) => e.attemptId === id && e.type === "attempt.tool_call"))
        break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const started = Date.now();
    await requestCancel(db.db, id);
    const a = await waitFor(id, 15_000);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(a.status).toBe("cancelled");
    expect((await docker(["ps", "-aq", "--filter", `label=brio.attempt=${id}`])).stdout.trim()).toBe("");
  });

  it("a cost breach ends the run with limit_exceeded", async () => {
    const id = await queue({
      adapter: "fake-cli",
      key: "cli-expensive",
      cliMode: "expensive",
      maxCostUsd: 1,
    });
    await enqueueAttempt(boss, id);
    const a = await waitFor(id);
    expect(a.status).toBe("failed");
    expect(a.exitReason).toMatch(/^limit_exceeded: cost \$5 passed the limit of \$1/);
  });

  it("secrets never reach events or logs, and output containing one is quarantined", async () => {
    const id = await queue({ adapter: "fake-cli", key: "cli-leaky", cliMode: "leaky" });
    await enqueueAttempt(boss, id);
    const a = await waitFor(id);
    expect(a.status, a.exitReason ?? "").toBe("succeeded");
    const events = (await readEventsSince(db.db, missionId, 0)).filter((e) => e.attemptId === id);
    expect(JSON.stringify(events)).not.toContain(KEY);
    expect(JSON.stringify(events)).toContain("[redacted]");
    expect(logs.join("\n")).not.toContain(KEY);
    const stored = await db.db.select().from(artifacts).where(eq(artifacts.attemptId, id));
    const diff = stored.find((x) => x.kind === "diff")!;
    expect(diff.meta).toMatchObject({ quarantined: true });
    const all = await db.db.select().from(blobs).where(eq(blobs.workspaceId, ws.id));
    expect(all.some((b) => b.bytes.toString("utf8").includes(KEY))).toBe(false);
  });

  it("the reaper fails attempts whose runner stopped heartbeating", async () => {
    const id = await queue({ adapter: "fake-cli", key: "orphan" });
    await db.db
      .update(attempts)
      .set({ status: "running", runnerId: "runner-dead", heartbeatAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(attempts.id, id));
    const r = await runner.reap();
    expect(r.lost).toBeGreaterThanOrEqual(1);
    const [a] = await db.db.select().from(attempts).where(eq(attempts.id, id));
    expect(a).toMatchObject({
      status: "failed",
      exitReason: "failed: runner runner-dead stopped responding",
    });
    const last = (await readEventsSince(db.db, missionId, 0)).filter((e) => e.attemptId === id).at(-1);
    expect(last?.type).toBe("attempt.finished");
  });
});
