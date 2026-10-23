import { schema } from "@brio/db";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { HttpError, requireMember, requireSession, workspaceFor } from "../http";

const { attempts, artifacts, blobs } = schema;

const Params = z.object({ id: z.uuid() });
const RunBody = z.object({ agentId: z.uuid() });

export function presentAttempt(a: typeof attempts.$inferSelect) {
  return {
    id: a.id,
    taskId: a.taskId,
    agentId: a.agentId,
    role: a.role,
    status: a.status,
    startedAt: a.startedAt,
    endedAt: a.endedAt,
    costUsd: a.costUsd,
    tokensIn: a.tokensIn,
    tokensOut: a.tokensOut,
    exitReason: a.exitReason,
  };
}

export async function attemptRoutes(app: FastifyInstance, ctx: AppContext) {
  /** Runs one task now with the chosen agent (a user action, so it is the approval for this dispatch). */
  app.post("/v1/tasks/:id/attempts", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s.userId, ["owner", "admin", "member"]);
    const { id } = Params.parse(req.params);
    const { agentId } = RunBody.parse(req.body);
    const attempt = await ctx.attempts.start({ workspaceId, taskId: id, agentId, userId: s.userId });
    return reply.status(202).send({ attempt: presentAttempt(attempt) });
  });

  app.get("/v1/tasks/:id/attempts", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s.userId);
    const { id } = Params.parse(req.params);
    const rows = await ctx.db
      .select()
      .from(attempts)
      .where(and(eq(attempts.taskId, id), eq(attempts.workspaceId, workspaceId)))
      .orderBy(desc(attempts.createdAt));
    return { attempts: rows.map(presentAttempt) };
  });

  app.post("/v1/attempts/:id/cancel", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s.userId, ["owner", "admin", "member"]);
    const cancelled = await ctx.attempts.cancel(Params.parse(req.params).id, workspaceId);
    if (!cancelled) throw new HttpError(409, "the attempt is not running", "not_running");
    return { cancelled: true };
  });

  /** The agent's answer, stored as a report artifact. */
  app.get("/v1/attempts/:id/output", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s.userId);
    const { id } = Params.parse(req.params);
    const [row] = await ctx.db
      .select({ bytes: blobs.bytes, contentType: blobs.contentType, sha256: artifacts.sha256 })
      .from(artifacts)
      .innerJoin(blobs, and(eq(blobs.workspaceId, artifacts.workspaceId), eq(blobs.sha256, artifacts.sha256)))
      .where(
        and(
          eq(artifacts.attemptId, id),
          eq(artifacts.workspaceId, workspaceId),
          eq(artifacts.kind, "report"),
        ),
      );
    if (!row) throw new HttpError(404, "this attempt has no output", "not_found");
    return reply
      .header("content-type", row.contentType)
      .header("x-content-type-options", "nosniff")
      .header("etag", `"${row.sha256}"`)
      .send(row.bytes);
  });
}
