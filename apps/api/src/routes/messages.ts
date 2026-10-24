// The mission's mailbox as people see it: agents' questions, blockers and review requests, and the user's answers.
// Also a person's verdict on a task waiting for review.
import { schema } from "@brio/db";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { HttpError, one, requireMember, requireSession } from "../http";
import { requireRunnerOwner } from "../runner-owner";

const { messages, missions, tasks } = schema;
const Params = z.object({ id: z.uuid() });
const Answer = z.object({ text: z.string().trim().min(1).max(20_000) });
const Review = z.object({
  verdict: z.enum(["pass", "revise", "fail"]),
  reasons: z.string().max(4000).default(""),
});

export async function messageRoutes(app: FastifyInstance, ctx: AppContext) {
  /** A mission's messages: agents' questions and answers, blockers and review requests. */
  app.get("/v1/missions/:id/messages", async (req) => {
    const s = await requireSession(ctx, req);
    const { id } = Params.parse(req.params);
    const [m] = await ctx.db.select().from(missions).where(eq(missions.id, id));
    if (!m) throw new HttpError(404, "mission not found", "not_found");
    await requireMember(ctx, m.workspaceId, s);
    const rows = await ctx.db
      .select({ msg: messages, toTask: tasks.key })
      .from(messages)
      .leftJoin(tasks, eq(tasks.id, messages.toTaskId))
      .where(eq(messages.missionId, m.id))
      .orderBy(asc(messages.createdAt));
    return {
      messages: rows.map(({ msg, toTask }) => ({
        id: msg.id,
        kind: msg.kind,
        body: msg.body,
        status: msg.status,
        to: msg.toUser ? "user" : (toTask ?? "agent"),
        replyToId: msg.replyToId,
        fromAttemptId: msg.fromAttemptId,
        createdAt: msg.createdAt,
      })),
    };
  });

  /** A person answers a question (or closes a blocker) addressed to the user. */
  app.post("/v1/messages/:id/answer", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const { id } = Params.parse(req.params);
    const { text } = Answer.parse(req.body);
    const [q] = await ctx.db.select().from(messages).where(eq(messages.id, id));
    if (!q?.toUser) throw new HttpError(404, "no question for you with that id", "not_found");
    await requireMember(ctx, q.workspaceId, s, ["owner", "admin", "member"]);
    if (q.status !== "open") throw new HttpError(409, "already answered", "answered");
    const row = await ctx.db.transaction(async (tx) => {
      const a = one(
        await tx
          .insert(messages)
          .values({
            workspaceId: q.workspaceId,
            missionId: q.missionId,
            toAttemptId: q.fromAttemptId,
            toUser: q.fromAttemptId === null,
            kind: "answer",
            replyToId: q.id,
            body: text,
          })
          .returning(),
        "message",
      );
      await tx
        .update(messages)
        .set({ status: q.kind === "question" ? "answered" : "closed" })
        .where(eq(messages.id, q.id));
      await ctx.events.append(tx, {
        workspaceId: q.workspaceId,
        missionId: q.missionId,
        type: "message.answered",
        actor: `user:${s.userId}`,
        payload: { messageId: a.id, questionId: q.id, from: "user", body: text },
      });
      return a;
    });
    return reply.status(201).send({ message: { id: row.id } });
  });

  /** A person's verdict on a task waiting for review (human checks; the M5 check kinds until the verifier). */
  app.post("/v1/tasks/:id/review", async (req) => {
    const s = await requireSession(ctx, req);
    const { id } = Params.parse(req.params);
    const body = Review.parse(req.body);
    const [t] = await ctx.db.select().from(tasks).where(eq(tasks.id, id));
    if (!t) throw new HttpError(404, "task not found", "not_found");
    await requireMember(ctx, t.workspaceId, s, ["owner", "admin", "member"]);
    const [m] = await ctx.db
      .select()
      .from(missions)
      .where(and(eq(missions.id, t.missionId)));
    if (!m) throw new HttpError(404, "mission not found", "not_found");
    // A review's reasons go to the agent that revises: on someone's machine, only they review.
    await requireRunnerOwner(ctx.db, m.projectId, s.userId, "review results");
    await ctx.orchestrator.review(m, t, body.verdict, body.reasons, s.userId);
    return { reviewed: body.verdict };
  });
}
