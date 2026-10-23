import { type MissionReport, renderMissionReport } from "@brio/core";
import { type DbOrTx, schema, streamMissionEvents } from "@brio/db";
import { type Actor, MissionPriority, MissionRouting, PlanGraph } from "@brio/schema";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { presentDelivery } from "../deliveries";
import { HttpError, one, requireMember, requireSession, workspaceFor } from "../http";
import { CreateMission, createMission } from "../missions";
import { missionReport } from "../orchestrator/report";
import { presentAttempt } from "./attempts";

const { attempts, missions, plans, tasks } = schema;

const Params = z.object({ id: z.uuid() });

const SSE_KEEPALIVE_MS = 15_000;

export async function missionRoutes(app: FastifyInstance, ctx: AppContext) {
  /**
   * Creates a mission and starts planning it: a planning task (plan version 0) is dispatched to a planner agent, whose
   * answer becomes plan v1 for the user to edit and approve (or approved automatically when allowed and small).
   */
  app.post("/v1/missions", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    const mission = await createMission(ctx, s, workspaceId, CreateMission.parse(req.body));
    return reply.status(201).send({ mission: presentMission(mission) });
  });

  app.get("/v1/missions", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s);
    const rows = await ctx.db
      .select()
      .from(missions)
      .where(eq(missions.workspaceId, workspaceId))
      .orderBy(desc(missions.createdAt))
      .limit(100);
    return { missions: rows.map(presentMission) };
  });

  /** The mission report: live while it runs, the final snapshot once it ends. `?format=md` returns Markdown. */
  app.get("/v1/missions/:id/report", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const m = await loadMission(ctx.db, Params.parse(req.params).id);
    await requireMember(ctx, m.workspaceId, s);
    const saved = (m.report as { final?: MissionReport } | null)?.final;
    const report = saved ?? (await missionReport(ctx.db, m.id));
    if (!report) throw new HttpError(404, "mission not found", "not_found");
    if ((req.query as { format?: string }).format === "md")
      return reply.type("text/markdown; charset=utf-8").send(renderMissionReport(report));
    return { report, final: Boolean(saved) };
  });

  app.get("/v1/missions/:id", async (req) => {
    const s = await requireSession(ctx, req);
    const m = await loadMission(ctx.db, Params.parse(req.params).id);
    await requireMember(ctx, m.workspaceId, s);
    const [plan] = await ctx.db
      .select()
      .from(plans)
      .where(eq(plans.missionId, m.id))
      .orderBy(desc(plans.version))
      .limit(1);
    const taskRows = await ctx.db
      .select()
      .from(tasks)
      .where(eq(tasks.missionId, m.id))
      .orderBy(asc(tasks.createdAt));
    const attemptRows = taskRows.length
      ? await ctx.db
          .select()
          .from(attempts)
          .where(
            inArray(
              attempts.taskId,
              taskRows.map((t) => t.id),
            ),
          )
          .orderBy(desc(attempts.createdAt))
      : [];
    return {
      mission: presentMission(m),
      plan: plan
        ? {
            version: plan.version,
            status: plan.status,
            graph: plan.graph,
            lint: plan.lint,
            origin: plan.origin,
          }
        : null,
      tasks: taskRows.map((t) => ({
        id: t.id,
        key: t.key,
        type: t.type,
        title: t.title,
        status: t.status,
        mode: t.mode,
        pinnedAgentId: t.pinnedAgentId,
        planVersion: t.planVersion,
        dependsOn: t.dependsOn,
        blockedReason: t.blockedReason,
        revisions: t.revisions,
        sensitivity: t.contract.sensitivity,
        ...routeView(t.modeParams),
        attempts: attemptRows.filter((a) => a.taskId === t.id).map(presentAttempt),
      })),
      // Who holds which files or resources now, and who held them (the live board's leases view).
      leases: taskRows.length
        ? (
            await ctx.db
              .select()
              .from(schema.leases)
              .where(
                inArray(
                  schema.leases.taskId,
                  taskRows.map((t) => t.id),
                ),
              )
              .orderBy(desc(schema.leases.createdAt))
              .limit(200)
          ).map((l) => ({
            id: l.id,
            taskId: l.taskId,
            taskKey: taskRows.find((t) => t.id === l.taskId)?.key ?? null,
            resourceKind: l.resourceKind,
            resource: l.resource,
            mode: l.mode,
            expiresAt: l.expiresAt,
            releasedAt: l.releasedAt,
            createdAt: l.createdAt,
          }))
        : [],
      // The latest merge of the mission's work: its branch, checks and the merged diff.
      integration: await ctx.db
        .select()
        .from(schema.integrations)
        .where(eq(schema.integrations.missionId, m.id))
        .orderBy(desc(schema.integrations.planVersion), desc(schema.integrations.round))
        .limit(1)
        .then(([i]) =>
          i
            ? {
                id: i.id,
                round: i.round,
                status: i.status,
                branch: i.branch,
                commit: i.commit,
                diffArtifactId: i.diffArtifactId,
                conflicts: i.conflicts,
                checks: i.checks.map(({ command, passed, exitCode }) => ({ command, passed, exitCode })),
              }
            : null,
        ),
      deliveries: (
        await ctx.db
          .select()
          .from(schema.deliveries)
          .where(eq(schema.deliveries.missionId, m.id))
          .orderBy(asc(schema.deliveries.createdAt))
      ).map(presentDelivery),
    };
  });

  /**
   * Server-Sent Events for one mission. Resumes after the Last-Event-ID header (sent by EventSource on reconnect) or the
   * `lastEventId` query parameter; reads always come from the events table, so there are no gaps or duplicates.
   */
  app.get("/v1/missions/:id/events", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const m = await loadMission(ctx.db, Params.parse(req.params).id);
    await requireMember(ctx, m.workspaceId, s);
    const header = req.headers["last-event-id"];
    const raw =
      (Array.isArray(header) ? header[0] : header) ??
      (req.query as { lastEventId?: string }).lastEventId ??
      "0";
    const afterSeq = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0)
      throw new HttpError(400, "Last-Event-ID must be a non-negative integer");

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 2000\n\n");

    const abort = new AbortController();
    const keepalive = setInterval(() => res.write(": keepalive\n\n"), SSE_KEEPALIVE_MS);
    const rotate = setTimeout(() => abort.abort(), ctx.config.BRIO_SSE_MAX_CONNECTION_MS);
    req.raw.on("close", () => abort.abort());
    try {
      await streamMissionEvents(
        ctx.db,
        ctx.feed,
        m.id,
        (e) => {
          res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        },
        { afterSeq, signal: abort.signal },
      );
    } catch (err) {
      req.log.error({ err }, "event stream failed");
    } finally {
      clearInterval(keepalive);
      clearTimeout(rotate);
      res.end();
    }
  });
}

export async function loadMission(db: DbOrTx, id: string) {
  const [m] = await db.select().from(missions).where(eq(missions.id, id));
  if (!m) throw new HttpError(404, "mission not found", "not_found");
  return m;
}

export function presentMission(m: typeof missions.$inferSelect) {
  return {
    id: m.id,
    workspaceId: m.workspaceId,
    title: m.title,
    goal: m.goal,
    status: m.status,
    priority: m.priority,
    lastEventSeq: m.lastEventSeq,
    blockedReason: m.blockedReason,
    autoApprove: m.autoApprove,
    budget: m.budget,
    routing: m.routing,
    projectId: m.projectId,
    inputs: {
      issue: m.inputs.issue ? { url: m.inputs.issue.url, title: m.inputs.issue.title } : null,
      files: (m.inputs.files ?? []).map(({ name, size, text }) => ({ name, size, text })),
    },
    createdAt: m.createdAt,
  };
}

/** How the router staffed a task and why, and the result a multi-agent mode settled on (for the board). */
function routeView(params: Record<string, unknown>) {
  const p = params as {
    route?: {
      mode: string;
      agents: { agentId: string; role: string }[];
      rationale: string;
      degraded?: string;
    };
    result?: { attemptId: string; note: string };
  };
  return {
    route: p.route
      ? {
          mode: p.route.mode,
          agents: p.route.agents,
          rationale: p.route.rationale,
          degraded: p.route.degraded ?? null,
        }
      : null,
    result: p.result ?? null,
  };
}
