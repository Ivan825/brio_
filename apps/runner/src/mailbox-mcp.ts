// brio-mailbox as an MCP server (ADAPTER_SPEC §2.6) for coding CLIs in sandboxes. The runner serves it over streamable
// HTTP; each attempt gets its own bearer token, which maps to that attempt's mailbox, so an agent can only speak as
// itself. Sandboxes reach it through their egress proxy at http://brio-mailbox:8080/mcp (D-43); it is never on the
// internet.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Mailbox } from "@brio/adapters";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

/** Where sandboxes find the mailbox: the proxy's alias on their internal network. */
export const SANDBOX_MAILBOX_URL = "http://brio-mailbox:8080/mcp";

type Text = { content: Array<{ type: "text"; text: string }> };
const text = (t: string): Text => ({ content: [{ type: "text", text: t }] });

function build(mailbox: Mailbox): McpServer {
  const s = new McpServer({ name: "brio-mailbox", version: "1.0.0" });
  s.registerTool(
    "ask_agent",
    {
      description:
        "Ask the agent working on another task of this mission a question; waits a while for the answer.",
      inputSchema: { task_key: z.string(), question: z.string() },
    },
    async ({ task_key, question }) => text(await mailbox.askAgent(task_key, question)),
  );
  s.registerTool(
    "inbox",
    { description: "Questions and notes other agents or the user sent to your task." },
    async () => {
      const m = await mailbox.inbox();
      return text(
        m.length
          ? m.map((x) => `message ${x.id} (${x.kind} from ${x.from}): ${x.body}`).join("\n")
          : "no new messages",
      );
    },
  );
  s.registerTool(
    "answer",
    {
      description: "Answer a question sent to your task.",
      inputSchema: { message_id: z.string(), text: z.string() },
    },
    async ({ message_id, text: body }) => {
      await mailbox.answer(message_id, body);
      return text("answered");
    },
  );
  s.registerTool(
    "report_blocker",
    {
      description: "Report something that stops you from finishing.",
      inputSchema: { description: z.string() },
    },
    async ({ description }) => {
      await mailbox.reportBlocker(description);
      return text("reported");
    },
  );
  s.registerTool(
    "request_review",
    { description: "Ask a person to review something.", inputSchema: { note: z.string() } },
    async ({ note }) => {
      await mailbox.requestReview(note);
      return text("review requested");
    },
  );
  s.registerTool(
    "report_progress",
    { description: "Post a short progress note to the mission board.", inputSchema: { note: z.string() } },
    async ({ note }) => {
      await mailbox.reportProgress(note);
      return text("posted");
    },
  );
  s.registerTool(
    "get_contract",
    { description: "Read a named interface contract of this mission.", inputSchema: { name: z.string() } },
    async ({ name }) => text(await mailbox.getContract(name)),
  );
  s.registerTool(
    "get_brief",
    { description: "The mission brief: goal, contracts and what earlier tasks handed over." },
    async () => text(await mailbox.getBrief()),
  );
  return s;
}

export class MailboxMcpServer {
  private server: Server | null = null;
  private readonly byToken = new Map<string, Mailbox>();

  get port(): number {
    return (this.server?.address() as AddressInfo | null)?.port ?? 0;
  }

  /** Listens on all interfaces (sandboxes reach it through the Docker host gateway); every request needs a token. */
  async start(port = 0): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(port, "0.0.0.0", resolve));
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  /** A token for one attempt's mailbox; revoke it when the attempt ends. */
  register(mailbox: Mailbox): string {
    const token = randomBytes(24).toString("base64url");
    this.byToken.set(token, mailbox);
    return token;
  }

  revoke(token: string): void {
    this.byToken.delete(token);
  }

  private async handle(req: IncomingMessage, res: import("node:http").ServerResponse) {
    if (new URL(req.url ?? "/", "http://x").pathname !== "/mcp") return void res.writeHead(404).end();
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const mailbox = token ? this.byToken.get(token) : undefined;
    if (!mailbox)
      return void res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unknown token"}');
    // Stateless: a fresh server and transport per request, bound to this attempt's mailbox.
    const server = build(mailbox);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }
}
