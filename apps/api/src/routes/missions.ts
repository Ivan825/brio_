import { type DbOrTx, schema, streamMissionEvents } from "@brio/db";
import { type Actor, MissionPriority } from "@brio/schema";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { HttpError, one, requireMember, requireSession, workspaceFor } from "../http";
import { presentAttempt } from "./attempts";

const { attempts, missions, plans, tasks } = schema;

const CreateMission = z.object({
  goal: z.string().trim().min(1).max(10_000),
  title: z.string().trim().min(1).max(200).optional(),
  projectId: z.uuid().optional(),
  priority: MissionPriority.default("balanced"),
  budget: z
    .object({ usd: z.number().positive().optional(), minutes: z.number().positive().optional() })
    .optional(),
  /** The agent that plans; omitted, the static router picks a model-API agent. */
  plannerAgentId: z.uuid().optional(),
  /** Start without waiting for approval when the plan is clean and small (≤ $5, ≤ 10 tasks). */
  autoApprove: z.boolean().default(false),
});
const Params = z.object({ id: z.uuid() });

const titleFrom = (goal: string) => (goal.length <= 80 ? goal : `${goal.slice(0, 77).trimEnd()}…`);

const SSE_KEEPALIVE_MS = 15_000;

export async function missionRoutes(app: FastifyInstance, ctx: AppContext) {
  /**
   * Creates a mission and starts planning it: a planning task (plan version 0) is dispatched to a planner agent, whose
   * answer becomes plan v1 for the user to edit and approve (or approved automatically when allowed and small).
   */
  app.post("/v1/missions", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s.userId, ["owner", "admin", "member"]);
    const body = CreateMission.parse(req.body);
    const actor: Actor = `user:${s.userId}`;
    if (body.projectId) {
      const [p] = await ctx.db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(and(eq(schema.projects.id, body.projectId), eq(schema.projects.workspaceId, workspaceId)));
      if (!p) throw new HttpError(404, "project not found", "not_found");
    }
    const mission = await ctx.db.transaction(async (tx) => {
      const m = one(
        await tx
          .insert(missions)
          .values({
            workspaceId,
            projectId: body.projectId ?? null,
            title: body.title ?? titleFrom(body.goal),
            goal: body.goal,
            priority: body.priority,
            budget: body.budget ?? {},
            plannerAgentId: body.plannerAgentId ?? null,
            autoApprove: body.autoApprove,
            status: "planning",
            createdBy: s.userId,
          })
          .returning(),
        "mission",
      );
      await ctx.events.append(tx, {
        workspaceId,
        missionId: m.id,
        type: "mission.created",
        actor,
        payload: { title: m.title, goal: m.goal, priority: m.priority, budget: m.budget },
      });
      return m;
    });
    await ctx.orchestrator.startMission(mission);
    return reply.status(201).send({ mission: present(mission) });
  });

  app.get("/v1/missions", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s.userId);
    const rows = await ctx.db
      .select()
      .from(missions)
      .where(eq(missions.workspaceId, workspaceId))
      .orderBy(desc(missions.createdAt))
      .limit(100);
    return { missions: rows.map(present) };
  });

  app.get("/v1/missions/:id", async (req) => {
    const s = await requireSession(ctx, req);
    const m = await loadMission(ctx.db, Params.parse(req.params).id);
    await requireMember(ctx, m.workspaceId, s.userId);
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
      mission: present(m),
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
        attempts: attemptRows.filter((a) => a.taskId === t.id).map(presentAttempt),
      })),
    };
  });

  /**
   * Server-Sent Events for one mission. Resumes after the Last-Event-ID header (sent by EventSource on reconnect) or the
   * `lastEventId` query parameter; reads always come from the events table, so there are no gaps or duplicates.
   */
  app.get("/v1/missions/:id/events", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const m = await loadMission(ctx.db, Params.parse(req.params).id);
    await requireMember(ctx, m.workspaceId, s.userId);
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

async function loadMission(db: DbOrTx, id: string) {
  const [m] = await db.select().from(missions).where(eq(missions.id, id));
  if (!m) throw new HttpError(404, "mission not found", "not_found");
  return m;
}

function present(m: typeof missions.$inferSelect) {
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
    createdAt: m.createdAt,
  };
}
