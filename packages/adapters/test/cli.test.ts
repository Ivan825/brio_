// The coding-CLI adapters against recorded-format streams: argv per verified --help, events, usage and cost, error
// handling, plus the CLI contract (no sandbox → refuse, cancel kills, cost limit kills, credential only in env).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelPrice } from "@brio/core";
import { registry } from "@brio/registry";
import { describe, expect, it } from "vitest";
import { LimitExceeded } from "../src/errors";
import { ADAPTERS, CLI_ADAPTERS } from "../src/index";
import { NO_SANDBOX } from "../src/tools";
import type { AdapterEvent, AgentAdapter, AgentConfig, RunContext, SandboxHandle } from "../src/types";
import { FAKE_KEY, helloInput, secret } from "./contract";

const read = (f: string) => readFileSync(resolve(import.meta.dirname, "fixtures/cli", f), "utf8").split("\n");
const price: ModelPrice = { inputPerM: 1, outputPerM: 2, cachedInputPerM: 0.1, cacheWritePerM: 1.25 };

interface Spawned {
  argv: string[];
  env: Record<string, string>;
  stdin?: string;
  killed: boolean;
}

/** A sandbox whose spawned process prints the given lines, optionally hanging until killed. */
function fakeSandbox(lines: string[], opts: { exitCode?: number; hang?: boolean; stderr?: string } = {}) {
  const spawned: Spawned[] = [];
  const writes: Record<string, string> = {};
  const sandbox: SandboxHandle = {
    ...NO_SANDBOX,
    available: true,
    writeFile: async (p, c) => {
      writes[p] = c;
    },
    spawn(argv, o) {
      const rec: Spawned = {
        argv,
        env: o.env,
        killed: false,
        ...(o.stdin !== undefined ? { stdin: o.stdin } : {}),
      };
      spawned.push(rec);
      let release: () => void = () => {};
      const killed = new Promise<void>((r) => {
        release = r;
      });
      return {
        lines: (async function* () {
          for (const l of lines) yield l;
          if (opts.hang) await killed;
        })(),
        exit: (async () => {
          if (opts.hang) await killed;
          return { code: rec.killed ? 137 : (opts.exitCode ?? 0), stderr: opts.stderr ?? "" };
        })(),
        kill: async () => {
          rec.killed = true;
          release();
        },
      };
    },
  };
  return { sandbox, spawned, writes };
}

function agentFor(adapter: AgentAdapter, model = "some-model"): AgentConfig {
  const spec = (adapter as AgentAdapter & { spec: { vendorPreset: string } }).spec;
  const preset = registry().preset(spec.vendorPreset)!;
  return {
    agentId: "a",
    name: adapter.key,
    model,
    rolePrompt: "",
    connector: {
      registryKey: preset.connector,
      presetKey: spec.vendorPreset,
      preset,
      baseUrl: preset.baseUrl!,
    },
    price,
  };
}

async function run(adapter: AgentAdapter, lines: string[], over: Partial<RunContext> = {}, sbxOpts = {}) {
  const sbx = fakeSandbox(lines, sbxOpts);
  const events: AdapterEvent[] = [];
  const ctx: RunContext = {
    credential: secret(),
    emit: (e) => events.push(e),
    signal: new AbortController().signal,
    sandbox: sbx.sandbox,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    fetch: globalThis.fetch,
    ...over,
  };
  const result = await adapter.run(helloInput(), agentFor(adapter), ctx);
  return { result, events, ...sbx };
}

const by = (key: string) => ADAPTERS[key]!;

describe("registration", () => {
  it("registers every coding CLI planned through M2 plus aider and goose", () => {
    expect(CLI_ADAPTERS.map((a) => a.key).sort()).toEqual(
      ["aider", "antigravity", "claude-code", "codex", "cursor-agent", "goose", "opencode"].sort(),
    );
    for (const a of CLI_ADAPTERS) {
      expect(a.route).toBe("cli");
      expect(registry().connector(a.spec.connector), a.key).toBeDefined();
      expect(registry().preset(a.spec.vendorPreset), a.key).toBeDefined();
      expect(a.spec.egressHosts.length, a.key).toBeGreaterThan(0);
    }
  });
});

describe("claude-code", () => {
  it("runs headless with stream-json, bypassed permissions, no repo settings, the prompt on stdin and the key in env", async () => {
    const { result, events, spawned } = await run(by("claude-code"), read("claude-code.ndjson"));
    expect(result.status, result.error).toBe("completed");
    const s = spawned[0]!;
    expect(s.argv.slice(0, 7)).toEqual([
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
    ]);
    expect(s.argv).toEqual(
      expect.arrayContaining(["--setting-sources", "", "--strict-mcp-config", "--max-budget-usd", "1"]),
    );
    expect(s.stdin).toContain("add a health endpoint");
    expect(s.argv.join(" ")).not.toContain(FAKE_KEY);
    expect(s.env.ANTHROPIC_API_KEY).toBe(FAKE_KEY);
    expect(result.output).toBe("Added sub() with a passing test.");
    expect(result.usage.usd).toBe(0.0421);
    expect(result.vendorRunId).toBe("6f0d2477-aaaa-bbbb-cccc-000000000001");
    expect(result.tokens).toMatchObject({
      inputTokens: 3000,
      cachedInputTokens: 8000,
      cacheWriteTokens: 1000,
      outputTokens: 600,
    });
    expect(events).toContainEqual({ kind: "file_edit", path: "math.js", op: "modify" });
    expect(events).toContainEqual({ kind: "tool_call", name: "Bash", args: { command: "node --test" } });
    expect(events.filter((e) => e.kind === "cost")).toHaveLength(1);
  });

  it("treats is_error as failure even when subtype says success", async () => {
    const { result } = await run(by("claude-code"), read("claude-code-error.ndjson"));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Invalid API key");
  });
});

describe("codex", () => {
  it("runs exec --json with its sandbox bypassed inside ours, sums per-turn usage and prices it", async () => {
    const { result, events, spawned } = await run(by("codex"), read("codex.ndjson"));
    expect(result.status, result.error).toBe("completed");
    expect(spawned[0]!.argv.slice(0, 6)).toEqual([
      "codex",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--ephemeral",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
    expect(spawned[0]!.env.CODEX_API_KEY).toBe(FAKE_KEY);
    expect(result.tokens).toMatchObject({
      inputTokens: 4000,
      cachedInputTokens: 8000,
      outputTokens: 700,
      reasoningTokens: 200,
    });
    expect(result.usage.usd).toBeCloseTo((4000 * 1 + 8000 * 0.1 + 700 * 2) / 1e6, 6);
    expect(events).toContainEqual({ kind: "file_edit", path: "math.test.js", op: "create" });
    expect(events).toContainEqual({
      kind: "tool_call",
      name: "shell",
      args: { command: "bash -lc 'node --test'" },
    });
    expect(result.output).toBe("Added sub() with a passing test.");
  });

  it("fails on turn.failed", async () => {
    const { result } = await run(by("codex"), read("codex-error.ndjson"), {}, { exitCode: 1 });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("401");
  });
});

describe("cursor-agent", () => {
  it("passes -p --trust --force, turns attribution off, and runs unmetered", async () => {
    const { result, events, spawned } = await run(by("cursor-agent"), read("cursor-agent.ndjson"));
    expect(result.status, result.error).toBe("completed");
    const argv = spawned[0]!.argv;
    expect(argv).toEqual(
      expect.arrayContaining([
        "-p",
        "--trust",
        "--force",
        "--output-format",
        "stream-json",
        "--approve-mcps",
      ]),
    );
    expect(argv[4]).toContain('"attributeCommitsToAgent":false');
    expect(spawned[0]!.env.CURSOR_API_KEY).toBe(FAKE_KEY);
    expect(result.usage.usd).toBe(0);
    expect(events).toContainEqual({ kind: "file_edit", path: "math.test.js", op: "modify" });
  });

  it("reports the plain-text invalid-key warning as the failure", async () => {
    const { result } = await run(
      by("cursor-agent"),
      ["⚠ Warning: The provided API key is invalid."],
      {},
      { exitCode: 1 },
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("API key is invalid");
  });

  it("checks its key on the first run instead of pretending to", async () => {
    const h = await by("cursor-agent").healthCheck(agentFor(by("cursor-agent")).connector, {
      credential: secret(),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      fetch: globalThis.fetch,
    });
    expect(h).toMatchObject({ ok: true, detail: expect.stringContaining("not verifiable") });
  });
});

describe("antigravity", () => {
  it("seeds API-key mode, skips permissions, and decides by the result event, not the exit status", async () => {
    const { result, events, spawned } = await run(by("antigravity"), read("antigravity.ndjson"));
    expect(result.status, result.error).toBe("completed");
    expect(spawned[0]!.argv[4]).toBe('{"modelProvider":"gemini"}');
    expect(spawned[0]!.argv).toEqual(
      expect.arrayContaining(["--dangerously-skip-permissions", "--output-format", "stream-json"]),
    );
    expect(spawned[0]!.env.GEMINI_API_KEY).toBe(FAKE_KEY);
    expect(result.output).toBe("Added sub() with a passing test.");
    expect(result.tokens).toMatchObject({
      inputTokens: 5000,
      cachedInputTokens: 4000,
      outputTokens: 800,
      reasoningTokens: 300,
    });
    expect(events).toContainEqual({ kind: "file_edit", path: "math.js", op: "modify" });
  });

  it("an ERROR result fails the run even when agy exits 0 (issue 548)", async () => {
    const { result } = await run(by("antigravity"), read("antigravity-error.ndjson"), {}, { exitCode: 0 });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("API key not valid");
  });
});

describe("opencode, goose, aider", () => {
  it("opencode sums step costs and tokens via OpenRouter", async () => {
    const { result, spawned } = await run(by("opencode"), read("opencode.ndjson"));
    expect(result.status, result.error).toBe("completed");
    expect(spawned[0]!.argv).toEqual(
      expect.arrayContaining([
        "run",
        "--format",
        "json",
        "--auto",
        "--pure",
        "--model",
        "openrouter/some-model",
      ]),
    );
    expect(spawned[0]!.env.OPENROUTER_API_KEY).toBe(FAKE_KEY);
    expect(result.usage.usd).toBe(0.0123);
  });

  it("goose reads complete events for usage and cost", async () => {
    const { result, events } = await run(by("goose"), read("goose.ndjson"));
    expect(result.status, result.error).toBe("completed");
    expect(result.usage.usd).toBe(0.0167);
    expect(events).toContainEqual({ kind: "file_edit", path: "math.test.js", op: "modify" });
  });

  it("aider is parsed from text: its session cost line, and never its own commits", async () => {
    const { result, spawned } = await run(by("aider"), read("aider.txt"));
    expect(result.status, result.error).toBe("completed");
    expect(spawned[0]!.argv).toEqual(
      expect.arrayContaining(["--no-auto-commits", "--no-attribute-author", "--yes-always"]),
    );
    expect(result.usage.usd).toBe(0.0119);
    expect(result.tokens).toMatchObject({ inputTokens: 2400, outputTokens: 312 });
  });
});

describe("CLI contract", () => {
  it("refuses to run without a sandbox", async () => {
    const r = await by("claude-code").run(helloInput(), agentFor(by("claude-code")), {
      credential: secret(),
      emit: () => {},
      signal: new AbortController().signal,
      sandbox: NO_SANDBOX,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      fetch: globalThis.fetch,
    });
    expect(r).toMatchObject({ status: "failed", error: "CLI agents run only inside a sandbox" });
  });

  it("cancel kills the process; a time limit ends as limit_exceeded", async () => {
    for (const [reason, status] of [
      [undefined, "cancelled"],
      [new LimitExceeded("ran past the 5-minute limit"), "limit_exceeded"],
    ] as const) {
      const ac = new AbortController();
      const pending = run(
        by("codex"),
        read("codex.ndjson").slice(0, 2),
        { signal: ac.signal },
        { hang: true },
      );
      setTimeout(() => ac.abort(reason), 20);
      const { result, spawned } = await pending;
      expect(result.status).toBe(status);
      expect(spawned[0]!.killed).toBe(true);
    }
  });

  it("kills the process when the reported cost passes the limit", async () => {
    const expensive = read("claude-code.ndjson").map((l) =>
      l.replace('"total_cost_usd":0.0421', '"total_cost_usd":3'),
    );
    const { result, spawned } = await run(by("claude-code"), expensive);
    expect(result.status).toBe("limit_exceeded");
    expect(spawned[0]!.killed).toBe(true);
  });

  it("scrubs the key if a CLI ever prints it", async () => {
    const leaky = [
      `{"type":"assistant","message":{"content":[{"type":"text","text":"key=${FAKE_KEY}"}]}}`,
      ...read("claude-code.ndjson"),
    ];
    const { result, events } = await run(by("claude-code"), leaky);
    expect(JSON.stringify({ result, events })).not.toContain(FAKE_KEY);
  });

  it("hands over prompts too long for one argument as a file", async () => {
    const adapter = by("codex");
    const sbx = fakeSandbox(read("codex.ndjson"));
    await adapter.run(helloInput({ instructions: "x".repeat(150_000) }), agentFor(adapter), {
      credential: secret(),
      emit: () => {},
      signal: new AbortController().signal,
      sandbox: sbx.sandbox,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      fetch: globalThis.fetch,
    });
    expect(sbx.writes[".brio/prompt.md"]?.length).toBeGreaterThan(150_000);
    expect(sbx.spawned[0]!.argv.at(-1)).toContain(".brio/prompt.md");
  });
});
