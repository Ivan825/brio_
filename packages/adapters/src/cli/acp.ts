// Driving a coding CLI over ACP, the Agent Client Protocol (docs/vendors/protocols.md §3), with the official SDK:
// initialize, authenticate only with a method that uses the key Brio put in the environment (never a browser sign-in),
// one session in the worktree with Brio's MCP servers, one prompt, its updates turned into Brio events. Every permission
// request is answered (unanswered ones block the agent): the sandbox is the boundary, so the agent may act inside it.
import * as acp from "@agentclientprotocol/sdk";
import type { AdapterEvent, McpServerConfig, SandboxProcess } from "../types";

export interface AcpSpec {
  /** argv that starts the CLI in ACP mode (e.g. `cursor-agent acp`). */
  argv: string[];
  /** Authentication methods to use when the agent asks, in order (ones that read the key from the environment). */
  authMethods?: string[];
}

export interface AcpOutcome {
  stopReason: string;
  text: string;
  sessionId: string;
  /** Cumulative USD the agent reported (usage_update), if it did. */
  usd?: number;
}

/** An ACP byte stream over a sandbox process's stdio. */
export function processStream(proc: SandboxProcess): acp.Stream {
  if (!proc.stdin) throw new Error("ACP needs an interactive process");
  const stdin = proc.stdin;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const output = new WritableStream<Uint8Array>({
    write: (chunk) => stdin.write(decoder.decode(chunk, { stream: true })),
    close: () => stdin.end(),
  });
  const input = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const line of proc.lines) controller.enqueue(encoder.encode(`${line}\n`));
      } finally {
        controller.close();
      }
    },
  });
  return acp.ndJsonStream(output, input);
}

/** Brio's MCP servers as ACP session servers (HTTP ones only when the agent takes them). */
function mcpServersFor(servers: McpServerConfig[], http: boolean): acp.McpServer[] {
  return servers.flatMap((s): acp.McpServer[] =>
    s.transport === "http" && http && s.url
      ? [
          {
            type: "http",
            name: s.name,
            url: s.url,
            headers: Object.entries(s.headers ?? {}).map(([name, value]) => ({ name, value })),
          },
        ]
      : [],
  );
}

const textOf = (c: unknown): string =>
  c && typeof c === "object" && (c as { type?: string }).type === "text"
    ? String((c as { text?: string }).text ?? "")
    : "";

/** Runs one prompt; resolves with how it stopped. Cancels the turn when `signal` aborts. */
export async function runAcp(o: {
  target: acp.Stream;
  cwd: string;
  prompt: string;
  mcpServers: McpServerConfig[];
  authMethods?: string[];
  emit: (e: AdapterEvent) => void;
  signal: AbortSignal;
}): Promise<AcpOutcome> {
  const out: AcpOutcome = { stopReason: "", text: "", sessionId: "" };
  const app = acp
    .client({ name: "brio" })
    .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
      const options = ctx.params.options ?? [];
      const allow =
        options.find((x) => x.kind === "allow_once") ?? options.find((x) => x.kind === "allow_always");
      o.emit({
        kind: "tool_call",
        name: "permission",
        args: { tool: ctx.params.toolCall?.title ?? "", allowed: Boolean(allow) },
      });
      return allow
        ? { outcome: { outcome: "selected", optionId: allow.optionId } }
        : { outcome: { outcome: "cancelled" } };
    });

  return app.connectWith(o.target, async (cx) => {
    const init = await cx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "brio", version: "1.0.0" },
    });
    const method = (init.authMethods ?? []).find((m) => o.authMethods?.includes(m.id));
    if (method) await cx.request(acp.methods.agent.authenticate, { methodId: method.id });
    const http = Boolean(init.agentCapabilities?.mcpCapabilities?.http);
    return cx
      .buildSession({ cwd: o.cwd, mcpServers: mcpServersFor(o.mcpServers, http) })
      .withSession(async (session) => {
        out.sessionId = session.sessionId;
        const onAbort = () =>
          void cx.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId }).catch(() => {});
        o.signal.addEventListener("abort", onAbort, { once: true });
        void session.prompt(o.prompt).catch(() => {});
        try {
          for (;;) {
            const m = await session.nextUpdate();
            if (m.kind === "stop") {
              out.stopReason = m.stopReason;
              break;
            }
            const u = m.update as acp.SessionUpdate & Record<string, unknown>;
            switch (u.sessionUpdate) {
              case "agent_message_chunk":
                out.text += textOf(u.content);
                break;
              case "tool_call": {
                o.emit({
                  kind: "tool_call",
                  name: String(u.kind ?? u.title ?? "tool"),
                  args: { title: u.title, input: u.rawInput },
                });
                for (const l of (u.locations as Array<{ path?: string }> | undefined) ?? [])
                  if (l.path && u.kind === "edit")
                    o.emit({ kind: "file_edit", path: l.path.replace(/^\/work\//, ""), op: "modify" });
                break;
              }
              case "tool_call_update":
                for (const c of (u.content as Array<{ type?: string; path?: string }> | undefined) ?? [])
                  if (c.type === "diff" && c.path)
                    o.emit({ kind: "file_edit", path: c.path.replace(/^\/work\//, ""), op: "modify" });
                break;
              case "plan": {
                const entries = (u.entries as Array<{ content?: string; status?: string }> | undefined) ?? [];
                if (entries.length)
                  o.emit({
                    kind: "progress",
                    note: entries
                      .map((e) => `${e.status === "completed" ? "✓" : "·"} ${e.content ?? ""}`)
                      .join("\n"),
                  });
                break;
              }
              case "usage_update": {
                const cost = u.cost as { amount?: number; currency?: string } | undefined;
                if (cost?.amount !== undefined && (cost.currency ?? "USD").toUpperCase() === "USD")
                  out.usd = cost.amount;
                break;
              }
              default:
                break;
            }
          }
        } finally {
          o.signal.removeEventListener("abort", onAbort);
        }
        if (out.text.trim()) o.emit({ kind: "message", role: "assistant", text: out.text.trim() });
        return out;
      });
  });
}
