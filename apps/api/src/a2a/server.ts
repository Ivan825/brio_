// Brio as an A2A agent (ARCHITECTURE §4.6, PRD F40; docs/vendors/protocols.md §1): an Agent Card at
// /.well-known/agent-card.json and a JSON-RPC endpoint at /a2a (A2A v1.0, with SSE streaming), built on the official
// SDK's request handler. Every message an agent sends becomes a mission in the caller's workspace; the A2A task follows
// the mission (working → input-required for a plan to approve or a question → completed with the report as an
// artifact) and is kept in Postgres, refreshed from the mission whenever it is read, so it survives restarts. Callers
// authenticate with a workspace API token.
import {
  AgentCard,
  type Artifact,
  type ListTasksRequest,
  type ListTasksResponse,
  type Message,
  type Part,
  Role,
  Task,
  TaskState,
  type TaskState as TaskStateValue,
} from "@a2a-js/sdk";
import {
  AgentEvent,
  type AgentExecutor,
  DefaultRequestHandler,
  type ExecutionEventBus,
  JsonRpcTransportHandler,
  type RequestContext,
  ServerCallContext,
  type TaskStore,
  type User,
  validateVersion,
} from "@a2a-js/sdk/server";
import { renderMissionReport } from "@brio/core";
import { schema } from "@brio/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import type { AppContext } from "../context";
import { HttpError, requireMember, requireSession, type SessionInfo } from "../http";
import { cancelMission, createMission } from "../missions";
import { approvePlan, awaitingPerson } from "../orchestrator/plans";
import { missionReport } from "../orchestrator/report";

const { a2aTasks, artifacts, messages, missions, plans, tasks } = schema;

/** The A2A caller: a person (by API token) acting in one workspace. */
class BrioUser implements User {
  constructor(readonly session: SessionInfo) {}
  get isAuthenticated() {
    return true;
  }
  get userName() {
    return this.session.userId;
  }
}

const sessionOf = (ctx: ServerCallContext): SessionInfo => {
  const u = ctx.user;
  if (!(u instanceof BrioUser)) throw new HttpError(401, "sign in with an API token", "unauthenticated");
  return u.session;
};

export function brioAgentCard(appUrl: string): AgentCard {
  const origin = appUrl.replace(/\/+$/, "");
  return AgentCard.fromJSON({
    name: "Brio",
    description:
      "A multi-agent orchestrator. Give it a goal: it plans the work, routes each piece to the best agent of any vendor (coding agents, model APIs, hosted agents, media and research), verifies the results and returns a report.",
    version: "1.0.0",
    supportedInterfaces: [{ url: `${origin}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    provider: { organization: "Brio", url: origin },
    documentationUrl: `${origin}/docs`,
    capabilities: { streaming: true, pushNotifications: false },
    securitySchemes: {
      brioToken: { httpAuthSecurityScheme: { scheme: "Bearer", bearerFormat: "Brio workspace API token" } },
    },
    securityRequirements: [{ schemes: { brioToken: { list: [] } } }],
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/markdown", "text/plain"],
    skills: [
      {
        id: "run_mission",
        name: "Run a mission",
        description: "Plan a goal into tasks, run them on the best agents, verify the work and report.",
        tags: ["orchestration", "multi-agent"],
        examples: [
          "Add rate limiting to the API and document it",
          "Research EU AI Act timelines and summarise",
        ],
      },
      {
        id: "code_change",
        name: "Change code",
        description: "Make a verified code change in a project repository (tests, review, integration).",
        tags: ["code", "tests"],
      },
      {
        id: "research_report",
        name: "Research report",
        description: "A cited research report from research agents, checked for sources.",
        tags: ["research", "citations"],
      },
    ],
  });
}

const text = (t: string, mediaType = "text/plain"): Part => ({
  content: { $case: "text", value: t },
  metadata: undefined,
  filename: "",
  mediaType,
});

const agentMessage = (taskId: string, contextId: string, t: string): Message => ({
  messageId: uuidv7(),
  contextId,
  taskId,
  role: Role.ROLE_AGENT,
  parts: [text(t)],
  metadata: undefined,
  extensions: [],
  referenceTaskIds: [],
});

/** What the caller asked for, as text: text parts, and data parts as JSON. */
function goalOf(m: Message): string {
  return m.parts
    .map((p) =>
      p.content?.$case === "text"
        ? p.content.value
        : p.content?.$case === "data"
          ? JSON.stringify(p.content.value)
          : p.content?.$case === "url"
            ? `Reference: ${p.content.value}`
            : "",
    )
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

interface Snapshot {
  state: TaskStateValue;
  message?: string;
  artifacts?: Artifact[];
}

/** Where a mission stands, as an A2A task state, with what the caller needs to know or do. */
async function snapshot(ctx: AppContext, missionId: string): Promise<Snapshot> {
  const [m] = await ctx.db.select().from(missions).where(eq(missions.id, missionId));
  if (!m) return { state: TaskState.TASK_STATE_FAILED, message: "the mission is gone" };
  const link = `${ctx.config.APP_URL.replace(/\/+$/, "")}/missions/${m.id}`;
  if (m.status === "done" || m.status === "failed") {
    const saved = (m.report as { final?: Parameters<typeof renderMissionReport>[0] } | null)?.final;
    const report = saved ?? (await missionReport(ctx.db, m.id));
    const files = await ctx.db
      .select({ id: artifacts.id, kind: artifacts.kind, meta: artifacts.meta })
      .from(tasks)
      .innerJoin(artifacts, eq(artifacts.id, tasks.resultArtifactId))
      .where(
        and(
          eq(tasks.missionId, m.id),
          inArray(artifacts.kind, ["image", "video", "audio", "file", "doc", "report"]),
        ),
      );
    const origin = ctx.config.APP_URL.replace(/\/+$/, "");
    const out: Artifact[] = [
      {
        artifactId: `report-${m.id}`,
        name: "report.md",
        description:
          "The mission report: what was done, by which agents, the evidence, cost and what is open.",
        parts: [text(report ? renderMissionReport(report) : m.status, "text/markdown")],
        metadata: { missionId: m.id, board: link },
        extensions: [],
      },
      ...files.map(
        (f): Artifact => ({
          artifactId: f.id,
          name: String((f.meta as { name?: string }).name ?? `${f.kind}-${f.id}`),
          description: `A ${f.kind} the mission produced (fetch with the same API token).`,
          parts: [
            {
              content: { $case: "url", value: `${origin}/v1/artifacts/${f.id}/content` },
              metadata: undefined,
              filename: String((f.meta as { name?: string }).name ?? ""),
              mediaType: String(
                (f.meta as { contentType?: string }).contentType ?? "application/octet-stream",
              ),
            },
          ],
          metadata: undefined,
          extensions: [],
        }),
      ),
    ];
    return m.status === "done"
      ? { state: TaskState.TASK_STATE_COMPLETED, message: `Done: ${m.title}. ${link}`, artifacts: out }
      : {
          state: TaskState.TASK_STATE_FAILED,
          message: `${m.blockedReason ?? "The mission failed"}. ${link}`,
          artifacts: out,
        };
  }
  if (m.status === "cancelled") return { state: TaskState.TASK_STATE_CANCELED, message: "Cancelled." };
  if (m.status === "draft" && m.blockedReason)
    return { state: TaskState.TASK_STATE_REJECTED, message: `Brio cannot start this: ${m.blockedReason}` };
  const [question] = await ctx.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.missionId, m.id),
        eq(messages.toUser, true),
        eq(messages.status, "open"),
        eq(messages.kind, "question"),
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(1);
  if (question)
    return {
      state: TaskState.TASK_STATE_INPUT_REQUIRED,
      message: `A question from the mission's agents: ${question.body}`,
    };
  if (await awaitingPerson(ctx.db, m))
    return {
      state: TaskState.TASK_STATE_INPUT_REQUIRED,
      message: `The plan needs approval (it is larger than a quick start allows, or has questions). Reply "approve" to start it, or review it at ${link}.`,
    };
  return { state: TaskState.TASK_STATE_WORKING, message: `Working: ${m.status}. ${link}` };
}

const TERMINAL = new Set<TaskStateValue>([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);
const INTERRUPTED = new Set<TaskStateValue>([
  TaskState.TASK_STATE_INPUT_REQUIRED,
  TaskState.TASK_STATE_AUTH_REQUIRED,
]);

/** A2A tasks in Postgres, held to the caller's workspace, refreshed from their mission on every read. */
class BrioTaskStore implements TaskStore {
  constructor(private readonly ctx: AppContext) {}

  async save(task: Task, context: ServerCallContext): Promise<void> {
    const s = sessionOf(context);
    const json = Task.toJSON(task) as Record<string, unknown>;
    const missionId = (task.metadata as { missionId?: string } | undefined)?.missionId ?? null;
    await this.ctx.db
      .insert(a2aTasks)
      .values({
        id: task.id,
        workspaceId: s.tokenWorkspaceId as string,
        userId: s.userId,
        missionId,
        contextId: task.contextId,
        task: json,
      })
      .onConflictDoUpdate({
        target: a2aTasks.id,
        set: { task: json, ...(missionId ? { missionId } : {}), updatedAt: new Date() },
      });
  }

  async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    const s = sessionOf(context);
    const size = Math.max(1, Math.min(params.pageSize ?? 50, 100));
    const offset = Number(params.pageToken || 0) || 0;
    const rows = await this.ctx.db
      .select()
      .from(a2aTasks)
      .where(
        and(
          eq(a2aTasks.workspaceId, s.tokenWorkspaceId as string),
          ...(params.contextId ? [eq(a2aTasks.contextId, params.contextId)] : []),
        ),
      )
      .orderBy(desc(a2aTasks.createdAt));
    const all: Task[] = [];
    for (const r of rows) {
      const t = await this.load(r.id, context);
      if (t && (!params.status || t.status?.state === params.status)) all.push(t);
    }
    const page = all.slice(offset, offset + size).map((t) => ({
      ...t,
      artifacts: params.includeArtifacts ? t.artifacts : [],
      history: params.historyLength === undefined ? t.history : t.history.slice(-params.historyLength),
    }));
    return {
      tasks: page,
      nextPageToken: offset + size < all.length ? String(offset + size) : "",
      pageSize: size,
      totalSize: all.length,
    };
  }

  async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
    const s = sessionOf(context);
    const [row] = await this.ctx.db
      .select()
      .from(a2aTasks)
      .where(and(eq(a2aTasks.id, taskId), eq(a2aTasks.workspaceId, s.tokenWorkspaceId as string)));
    if (!row) return undefined;
    const task = Task.fromJSON(row.task);
    // An executor that died with an API restart leaves the stored state behind: the mission knows better.
    if (row.missionId && task.status && !TERMINAL.has(task.status.state)) {
      const snap = await snapshot(this.ctx, row.missionId);
      if (snap.state !== task.status.state) {
        task.status = {
          state: snap.state,
          message: snap.message ? agentMessage(task.id, task.contextId, snap.message) : undefined,
          timestamp: new Date().toISOString(),
        };
        if (snap.artifacts) task.artifacts = snap.artifacts;
      }
    }
    return task;
  }
}

/** Runs each A2A message as a mission and reports its progress on the event bus. */
class BrioExecutor implements AgentExecutor {
  constructor(
    private readonly ctx: AppContext,
    private readonly pollMs: number,
  ) {}

  execute = async (rc: RequestContext, bus: ExecutionEventBus): Promise<void> => {
    const s = sessionOf(rc.context);
    const workspaceId = s.tokenWorkspaceId as string;
    const said = goalOf(rc.userMessage);
    let missionId = (rc.task?.metadata as { missionId?: string } | undefined)?.missionId;
    const status = (state: TaskStateValue, msg?: string) =>
      bus.publish(
        AgentEvent.statusUpdate({
          taskId: rc.taskId,
          contextId: rc.contextId,
          status: {
            state,
            message: msg ? agentMessage(rc.taskId, rc.contextId, msg) : undefined,
            timestamp: new Date().toISOString(),
          },
          metadata: undefined,
        }),
      );

    if (rc.task && missionId) {
      // A follow-up turn: it answers the open question, or approves the plan.
      bus.publish(AgentEvent.task({ ...rc.task, history: [...rc.task.history, rc.userMessage] }));
      await this.followUp(s, missionId, said);
    } else {
      if (!said) {
        bus.publish(
          AgentEvent.task({
            id: rc.taskId,
            contextId: rc.contextId,
            status: {
              state: TaskState.TASK_STATE_REJECTED,
              message: agentMessage(rc.taskId, rc.contextId, "Send a goal as text."),
              timestamp: new Date().toISOString(),
            },
            artifacts: [],
            history: [rc.userMessage],
            metadata: undefined,
          }),
        );
        bus.finished();
        return;
      }
      const m = await createMission(
        this.ctx,
        s,
        workspaceId,
        { goal: said, autoApprove: true },
        `user:${s.userId}`,
      );
      missionId = m.id;
      bus.publish(
        AgentEvent.task({
          id: rc.taskId,
          contextId: rc.contextId,
          status: {
            state: TaskState.TASK_STATE_SUBMITTED,
            message: undefined,
            timestamp: new Date().toISOString(),
          },
          artifacts: [],
          history: [rc.userMessage],
          metadata: { missionId: m.id },
        }),
      );
    }

    let last: string | null = null;
    for (;;) {
      const snap = await snapshot(this.ctx, missionId);
      const key = `${snap.state}:${snap.message ?? ""}`;
      if (key !== last) {
        last = key;
        if (snap.artifacts)
          for (const a of snap.artifacts)
            bus.publish(
              AgentEvent.artifactUpdate({
                taskId: rc.taskId,
                contextId: rc.contextId,
                artifact: a,
                append: false,
                lastChunk: true,
                metadata: undefined,
              }),
            );
        status(snap.state, snap.message);
      }
      // The stream ends at a final or interrupted state; a follow-up message picks it up again.
      if (TERMINAL.has(snap.state) || INTERRUPTED.has(snap.state)) break;
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    bus.finished();
  };

  private async followUp(s: SessionInfo, missionId: string, said: string) {
    const [m] = await this.ctx.db.select().from(missions).where(eq(missions.id, missionId));
    if (!m) return;
    const [question] = await this.ctx.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.missionId, m.id),
          eq(messages.toUser, true),
          eq(messages.status, "open"),
          eq(messages.kind, "question"),
        ),
      )
      .orderBy(asc(messages.createdAt))
      .limit(1);
    if (question) {
      await this.ctx.db.transaction(async (tx) => {
        await tx.insert(messages).values({
          workspaceId: question.workspaceId,
          missionId: m.id,
          toAttemptId: question.fromAttemptId,
          toUser: question.fromAttemptId === null,
          kind: "answer",
          replyToId: question.id,
          body: said,
        });
        await tx.update(messages).set({ status: "answered" }).where(eq(messages.id, question.id));
        await this.ctx.events.append(tx, {
          workspaceId: m.workspaceId,
          missionId: m.id,
          type: "message.answered",
          actor: `user:${s.userId}`,
          payload: { questionId: question.id, from: "user", body: said, via: "a2a" },
        });
      });
      return;
    }
    if (m.status === "awaiting_approval" && /^\s*(approve|approved|yes|go|go ahead|ok)\b/i.test(said)) {
      const [p] = await this.ctx.db
        .select()
        .from(plans)
        .where(and(eq(plans.missionId, m.id), eq(plans.status, "proposed")))
        .orderBy(asc(plans.version));
      if (p) {
        await approvePlan(this.ctx, m, p.version, `user:${s.userId}`, s.userId);
        this.ctx.orchestrator.schedule(m.id);
      }
    }
  }

  cancelTask = async (taskId: string, bus: ExecutionEventBus): Promise<void> => {
    const [row] = await this.ctx.db.select().from(a2aTasks).where(eq(a2aTasks.id, taskId));
    if (row?.missionId) {
      const [m] = await this.ctx.db.select().from(missions).where(eq(missions.id, row.missionId));
      if (m && !["done", "failed", "cancelled"].includes(m.status))
        await cancelMission(this.ctx, m, `user:${row.userId}`).catch(() => {});
    }
    bus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: row?.contextId ?? "",
        status: {
          state: TaskState.TASK_STATE_CANCELED,
          message: undefined,
          timestamp: new Date().toISOString(),
        },
        metadata: undefined,
      }),
    );
    bus.finished();
  };
}

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

export async function a2aRoutes(app: FastifyInstance, ctx: AppContext, opts: { pollMs?: number } = {}) {
  const card = brioAgentCard(ctx.config.APP_URL);
  const handler = new DefaultRequestHandler(
    card,
    new BrioTaskStore(ctx),
    new BrioExecutor(ctx, opts.pollMs ?? 2000),
  );
  const transport = new JsonRpcTransportHandler(handler);

  app.get("/.well-known/agent-card.json", async () => AgentCard.toJSON(card));

  app.post("/a2a", async (req, reply) => {
    // Only API tokens: an A2A caller acts as a person in one workspace.
    const session = await requireSession(ctx, req);
    if (!session.tokenWorkspaceId)
      throw new HttpError(401, "use an API token (Authorization: Bearer brio_pat_…)", "token_required");
    // An A2A caller starts missions, answers agents and approves plans: someone who may act in the workspace now.
    await requireMember(ctx, session.tokenWorkspaceId, session, ["owner", "admin", "member"]);
    const version = req.headers["a2a-version"];
    const context = new ServerCallContext({
      user: new BrioUser(session),
      ...(typeof version === "string" && version ? { requestedVersion: version } : {}),
    });
    validateVersion(context.requestedVersion, await handler.getAgentCard(), "JSONRPC");
    const result = await transport.handle(req.body as Record<string, unknown>, context);
    if (typeof (result as AsyncGenerator)[Symbol.asyncIterator] !== "function") return reply.send(result);
    const stream = result as AsyncGenerator<unknown>;
    reply.hijack();
    reply.raw.writeHead(200, SSE_HEADERS);
    try {
      for await (const event of stream) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (e) {
      reply.raw.write(
        `event: error\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: (req.body as { id?: unknown })?.id ?? null, error: JsonRpcTransportHandler.mapToJSONRPCError(e) })}\n\n`,
      );
    } finally {
      reply.raw.end();
    }
  });
}
