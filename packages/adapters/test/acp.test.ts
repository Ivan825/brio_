// ACP mode for coding CLIs (docs/vendors/protocols.md §3, D-74): the Cursor adapter, with protocol "acp", drives an ACP
// agent (here a real one built on the official SDK, connected through a fake sandbox's stdio) — initialize, the
// environment-key authentication method only, a session in /work with Brio's MCP servers, one prompt — and turns its
// updates into Brio events; every permission request gets an answer.
import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { cursorAgent } from "../src/cli/cursor-agent";
import type {
  AdapterEvent,
  AgentConfig,
  RunContext,
  RunInput,
  SandboxHandle,
  SandboxProcess,
} from "../src/types";
import { helloInput, secret } from "./contract";

const KEY = ["cursor", "key", "0123456789abcdefghijklmnop"].join("-");

interface Seen {
  argv: string[];
  env: Record<string, string>;
  auth: string[];
  session: { cwd?: string; mcpServers?: unknown[] } | null;
  prompt: string;
  permission: unknown;
  cancelled: boolean;
}

/** An ACP agent on the SDK; `slow` keeps the turn open until it is cancelled. */
function fakeAgent(seen: Seen, opts: { slow?: boolean; stopReason?: acp.StopReason } = {}) {
  return acp
    .agent({ name: "fake-cursor" })
    .onRequest(acp.methods.agent.initialize, async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { mcpCapabilities: { http: true, sse: false } },
      authMethods: [
        { id: "browser_login", name: "Sign in with a browser" },
        { id: "cursor_login", name: "Use CURSOR_API_KEY" },
      ],
    }))
    .onRequest(acp.methods.agent.authenticate, async (ctx) => {
      seen.auth.push(ctx.params.methodId);
      return {};
    })
    .onRequest(acp.methods.agent.session.new, async (ctx) => {
      seen.session = ctx.params as Seen["session"];
      return { sessionId: "sess-1" };
    })
    .onNotification(acp.methods.agent.session.cancel, async () => {
      seen.cancelled = true;
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      seen.prompt = ctx.params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
      const update = (u: Record<string, unknown>) =>
        ctx.client.notify(acp.methods.client.session.update, { sessionId: "sess-1", update: u as never });
      await update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Adding the endpoint." },
      });
      await update({
        sessionUpdate: "plan",
        entries: [{ content: "Write the handler", status: "completed", priority: "high" }],
      });
      seen.permission = await ctx.client.request(acp.methods.client.session.requestPermission, {
        sessionId: "sess-1",
        toolCall: { toolCallId: "t1", title: "Edit src/health.ts" },
        options: [
          { optionId: "no", name: "Reject", kind: "reject_once" },
          { optionId: "yes", name: "Allow", kind: "allow_once" },
        ],
      } as never);
      await update({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Edit src/health.ts",
        kind: "edit",
        status: "completed",
        locations: [{ path: "/work/src/health.ts" }],
      });
      if (opts.slow) while (!seen.cancelled) await new Promise((r) => setTimeout(r, 10));
      await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " Done." } });
      return { stopReason: opts.slow ? "cancelled" : (opts.stopReason ?? "end_turn") };
    });
}

/** A sandbox whose spawn starts the fake agent and wires its stdio as newline-delimited JSON. */
function sandboxFor(seen: Seen, agent: ReturnType<typeof fakeAgent>): SandboxHandle {
  return {
    available: true,
    readFile: async () => "",
    writeFile: async () => {},
    listFiles: async () => [],
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    spawn(argv, opts): SandboxProcess {
      seen.argv = argv;
      seen.env = opts.env;
      expect(opts.interactive).toBe(true);
      const toAgent = new TransformStream<Uint8Array, Uint8Array>();
      const toClient = new TransformStream<Uint8Array, Uint8Array>();
      agent.connect(acp.ndJsonStream(toClient.writable, toAgent.readable));
      const writer = toAgent.writable.getWriter();
      const encoder = new TextEncoder();
      let killed = false;
      let done: (v: { code: number | null; stderr: string }) => void = () => {};
      const exit = new Promise<{ code: number | null; stderr: string }>((r) => {
        done = r;
      });
      const lines = (async function* () {
        const reader = toClient.readable.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (!killed) {
          const { value, done: end } = await reader.read();
          if (end) break;
          buf += decoder.decode(value, { stream: true });
          let i = buf.indexOf("\n");
          while (i >= 0) {
            yield buf.slice(0, i);
            buf = buf.slice(i + 1);
            i = buf.indexOf("\n");
          }
        }
      })();
      return {
        lines,
        exit,
        kill: async () => {
          killed = true;
          done({ code: 0, stderr: "" });
        },
        stdin: {
          write: (t) => void writer.write(encoder.encode(t)),
          end: () => void writer.close().catch(() => {}),
        },
      };
    },
  };
}

function setup(opts: { slow?: boolean; stopReason?: acp.StopReason } = {}) {
  const seen: Seen = {
    argv: [],
    env: {},
    auth: [],
    session: null,
    prompt: "",
    permission: null,
    cancelled: false,
  };
  const events: AdapterEvent[] = [];
  const controller = new AbortController();
  const ctx: RunContext = {
    credential: secret(KEY),
    emit: (e) => void events.push(e),
    signal: controller.signal,
    sandbox: sandboxFor(seen, fakeAgent(seen, opts)),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    fetch: (() => {
      throw new Error("no network");
    }) as never,
  };
  const config: AgentConfig = {
    agentId: "a1",
    name: "cursor",
    model: "auto",
    rolePrompt: "",
    connector: { registryKey: "cursor-agent", baseUrl: "" },
    price: null,
    unitPrice: null,
    options: { protocol: "acp" },
  };
  const input: RunInput = {
    ...helloInput(),
    instructions: "Add a /health endpoint",
    mcpServers: [
      {
        name: "brio-mailbox",
        transport: "http",
        url: "http://brio-mailbox:8080/mcp",
        headers: { Authorization: "Bearer t0k" },
      },
    ],
  };
  return { seen, events, controller, ctx, config, input };
}

describe("ACP mode (Cursor first)", () => {
  it("runs a turn over ACP and reports what the agent did", async () => {
    const s = setup();
    const res = await cursorAgent.run(s.input, s.config, s.ctx);
    expect(res.status, res.error).toBe("completed");
    expect(res.output).toBe("Adding the endpoint. Done.");
    expect(res.vendorRunId).toBe("sess-1");
    // Started in ACP mode, with the key only in the environment.
    expect(s.seen.argv.at(-3)).toContain("exec cursor-agent acp");
    expect(s.seen.argv.join(" ")).not.toContain(KEY);
    expect(s.seen.env.CURSOR_API_KEY).toBe(KEY);
    // The environment-key method, never the browser sign-in.
    expect(s.seen.auth).toEqual(["cursor_login"]);
    expect(s.seen.session).toMatchObject({
      cwd: "/work",
      mcpServers: [
        {
          type: "http",
          name: "brio-mailbox",
          url: "http://brio-mailbox:8080/mcp",
          headers: [{ name: "Authorization", value: "Bearer t0k" }],
        },
      ],
    });
    expect(s.seen.prompt).toContain("Add a /health endpoint");
    expect(s.seen.permission).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
    expect(s.events).toContainEqual({ kind: "file_edit", path: "src/health.ts", op: "modify" });
    expect(s.events).toContainEqual({ kind: "progress", note: "✓ Write the handler" });
    expect(s.events.some((e) => e.kind === "tool_call" && e.name === "permission")).toBe(true);
    expect(JSON.stringify(s.events)).not.toContain(KEY);
  });

  it("cancels the turn over ACP when the attempt is cancelled", async () => {
    const s = setup({ slow: true });
    const run = cursorAgent.run(s.input, s.config, s.ctx);
    await new Promise((r) => setTimeout(r, 100));
    s.controller.abort();
    const res = await run;
    expect(res.status).toBe("cancelled");
    expect(s.seen.cancelled).toBe(true);
  });

  it("fails a turn the agent refused or cut short", async () => {
    const refused = setup({ stopReason: "refusal" });
    expect(await cursorAgent.run(refused.input, refused.config, refused.ctx)).toMatchObject({
      status: "failed",
      error: "cursor-agent refused the task",
    });
    const s = setup({ stopReason: "max_tokens" });
    const res = await cursorAgent.run(s.input, s.config, s.ctx);
    expect(res).toMatchObject({ status: "failed", error: "cursor-agent stopped early (max_tokens)" });
  });
});
