// Brio as an MCP server (ARCHITECTURE §4.5): streamable HTTP at /mcp, stateless (a server per request, bound to the
// caller), for Claude Code, Cursor, Codex and any MCP client. Callers authenticate with a workspace API token
// (`Authorization: Bearer brio_pat_…`) or an OAuth access token issued by Brio (remote clients). The same tools are
// served over stdio by `brio mcp` (apps/cli).
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { HttpError } from "../http";
import { mcpAuthenticator, mcpChallenge } from "./auth";
import { BrioTools, type Caller } from "./tools";

type Text = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const text = (t: string): Text => ({ content: [{ type: "text", text: t }] });

/** Runs a tool, turning Brio's refusals into tool errors the calling agent can read. */
async function run(fn: () => Promise<string>): Promise<Text> {
  try {
    return text(await fn());
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : `failed: ${(e as Error).message}`;
    return { ...text(msg), isError: true };
  }
}

const id = z.string().uuid();

export function buildBrioMcp(ctx: AppContext, caller: Caller, opts: { pollMs?: number } = {}): McpServer {
  const tools = new BrioTools(ctx, caller, opts);
  const s = new McpServer({ name: "brio", version: "1.0.0" });

  s.registerTool(
    "delegate",
    {
      description:
        "Give Brio a goal. It plans the work, routes each piece to the best agent (any vendor), verifies the results and returns the mission report. Waits up to wait_minutes (default 15; 0 returns at once).",
      inputSchema: {
        task: z.string().min(1).max(10_000).describe("What you want done, with any constraints"),
        title: z.string().max(200).optional(),
        project_id: id.optional().describe("A Brio project (repository) to work on"),
        priority: z.enum(["quality", "balanced", "cheap", "fast"]).optional(),
        budget_usd: z.number().positive().optional(),
        wait_minutes: z.number().min(0).max(60).optional(),
      },
    },
    async (a, extra) =>
      run(() =>
        tools.delegate(a, extra.signal, (status) => {
          const token = extra._meta?.progressToken;
          if (token !== undefined)
            void extra
              .sendNotification({
                method: "notifications/progress",
                params: { progressToken: token, progress: 0, message: `mission ${status}` },
              })
              .catch(() => {});
        }),
      ),
  );
  s.registerTool(
    "plan_mission",
    {
      description: "Plan a goal without running it. Returns the proposed plan; approve_plan starts it.",
      inputSchema: { goal: z.string().min(1).max(10_000), project_id: id.optional() },
    },
    async (a, extra) => run(() => tools.planMission(a, extra.signal)),
  );
  s.registerTool(
    "approve_plan",
    { description: "Approve a mission's proposed plan and start it.", inputSchema: { mission_id: id } },
    async (a) => run(() => tools.approvePlan(a)),
  );
  s.registerTool(
    "mission_status",
    {
      description: "A mission's status, its tasks, and the questions waiting for you.",
      inputSchema: { mission_id: id },
    },
    async (a) => run(() => tools.missionStatus(a)),
  );
  s.registerTool(
    "report",
    {
      description: "A mission's report: what was done, by which agents, the evidence, cost and what is open.",
      inputSchema: { mission_id: id },
    },
    async (a) => run(() => tools.report_(a)),
  );
  s.registerTool(
    "ask_agent",
    {
      description:
        "Ask the agent working on one of a mission's tasks a question; waits a while for its answer.",
      inputSchema: {
        mission_id: id,
        task_key: z.string().min(1),
        question: z.string().min(1).max(10_000),
        wait_seconds: z.number().min(5).max(600).optional(),
      },
    },
    async (a, extra) => run(() => tools.askAgent(a, extra.signal)),
  );
  s.registerTool(
    "answer",
    {
      description: "Answer a question a mission's agent asked you (ids come from mission_status).",
      inputSchema: { message_id: id, text: z.string().min(1).max(20_000) },
    },
    async (a) => run(() => tools.answer(a)),
  );
  s.registerTool(
    "get_brief",
    {
      description:
        "A mission's brief: goal, plan, what is done, decisions handed over and contracts in force; with paths or a topic, also what its project remembers about them (the decisions, contracts and prompts behind recent changes).",
      inputSchema: {
        mission_id: id,
        paths: z.array(z.string().min(1).max(500)).max(50).optional(),
        topic: z.string().min(1).max(300).optional(),
      },
    },
    async (a) => run(() => tools.getBrief(a)),
  );
  s.registerTool(
    "get_contract",
    {
      description: "Read a named interface contract of a mission.",
      inputSchema: { mission_id: id, name: z.string().min(1) },
    },
    async (a) => run(() => tools.getContract(a)),
  );
  s.registerTool(
    "request_review",
    {
      description: "Ask a person to review something on a mission's board (it lands in their inbox).",
      inputSchema: { mission_id: id, note: z.string().min(1).max(10_000) },
    },
    async (a) => run(() => tools.requestReview(a)),
  );
  s.registerTool(
    "pending_approvals",
    {
      description:
        "What waits for a person's yes in the workspace: plans, and actions such as opening a pull request.",
    },
    async () => run(() => tools.pendingApprovals()),
  );
  s.registerTool(
    "decide_approval",
    {
      description:
        "Approve or deny an action waiting for a yes (e.g. opening a pull request), as your person. Needs the brio:approve permission they grant when this client signs in.",
      inputSchema: {
        approval_id: id,
        decision: z.enum(["approve", "deny"]),
        reason: z.string().max(2000).optional(),
      },
    },
    async (a) => run(() => tools.decideApproval(a)),
  );
  s.registerTool("list_missions", { description: "The workspace's recent missions." }, async () =>
    run(() => tools.listMissions()),
  );
  return s;
}

/** The caller of an /mcp request, or a 401 with the challenge MCP clients expect. */
export type Authenticate = (req: FastifyRequest) => Promise<Caller>;

export async function mcpRoutes(app: FastifyInstance, ctx: AppContext, authenticate?: Authenticate) {
  const callerOf: Authenticate = authenticate ?? mcpAuthenticator(ctx);

  const handle = async (req: FastifyRequest, raw: { req: IncomingMessage; res: ServerResponse }) => {
    const caller = await callerOf(req);
    const server = buildBrioMcp(ctx, caller);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    raw.res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(raw.req, raw.res, req.body);
  };

  for (const method of ["POST", "GET", "DELETE"] as const)
    app.route({
      method,
      url: "/mcp",
      handler: async (req, reply) => {
        try {
          if (method !== "POST") {
            // Stateless: no server-initiated stream and no sessions to end.
            return reply.status(405).header("allow", "POST").send({ error: "method_not_allowed" });
          }
          reply.hijack();
          await handle(req, { req: req.raw, res: reply.raw });
        } catch (e) {
          if (reply.raw.headersSent) return;
          const status = e instanceof HttpError ? e.statusCode : 500;
          reply.raw.writeHead(status, {
            "content-type": "application/json",
            ...(status === 401 ? { "www-authenticate": mcpChallenge(ctx.config.APP_URL) } : {}),
          });
          reply.raw.end(
            JSON.stringify({
              error: e instanceof HttpError ? e.code : "error",
              message: (e as Error).message,
            }),
          );
        }
      },
    });
}
