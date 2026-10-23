// The approvals inbox (M8): everything in the workspace waiting for a person, across missions — plans to approve,
// results to review, questions and blockers from agents, and actions that need a yes (a pull request to open).
import { schema } from "@brio/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { requireMember, requireSession, workspaceFor } from "../http";

const { approvals, attempts, messages, missions, plans, tasks } = schema;

export type InboxItem =
  | { kind: "plan"; missionId: string; mission: string; version: number; at: Date }
  | {
      kind: "review";
      missionId: string;
      mission: string;
      taskId: string;
      taskKey: string;
      title: string;
      checks: Array<{ kind: string; summary: string | null }>;
      at: Date;
    }
  | {
      kind: "question" | "blocker" | "review_request";
      missionId: string;
      mission: string;
      messageId: string;
      body: string;
      at: Date;
    }
  | {
      kind: "action";
      missionId: string | null;
      mission: string | null;
      approvalId: string;
      action: string;
      requestedBy: string;
      at: Date;
    };

export async function inboxRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/v1/inbox", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s);
    const items: InboxItem[] = [];

    const waiting = await ctx.db
      .select({ m: missions, p: plans })
      .from(missions)
      .innerJoin(plans, and(eq(plans.missionId, missions.id), eq(plans.status, "proposed")))
      .where(and(eq(missions.workspaceId, workspaceId), eq(missions.status, "awaiting_approval")));
    for (const { m, p } of waiting)
      items.push({ kind: "plan", missionId: m.id, mission: m.title, version: p.version, at: p.createdAt });

    const verifying = await ctx.db
      .select({ t: tasks, m: missions })
      .from(tasks)
      .innerJoin(missions, eq(missions.id, tasks.missionId))
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, "verifying")));
    for (const { t, m } of verifying) {
      const rows = await ctx.db.select().from(attempts).where(eq(attempts.taskId, t.id));
      const human = rows
        .flatMap(
          (a) =>
            (a.checks as { items?: Array<{ kind: string; status: string; summary?: string }> } | null)
              ?.items ?? [],
        )
        .filter((i) => i.status === "needs_human");
      if (human.length)
        items.push({
          kind: "review",
          missionId: m.id,
          mission: m.title,
          taskId: t.id,
          taskKey: t.key,
          title: t.title,
          checks: human.map((i) => ({ kind: i.kind, summary: i.summary ?? null })),
          at: t.updatedAt,
        });
    }

    const open = await ctx.db
      .select({ q: messages, m: missions })
      .from(messages)
      .innerJoin(missions, eq(missions.id, messages.missionId))
      .where(
        and(
          eq(messages.workspaceId, workspaceId),
          eq(messages.toUser, true),
          eq(messages.status, "open"),
          inArray(messages.kind, ["question", "blocker", "review_request"]),
        ),
      )
      .orderBy(asc(messages.createdAt));
    for (const { q, m } of open)
      items.push({
        kind: q.kind as "question" | "blocker" | "review_request",
        missionId: m.id,
        mission: m.title,
        messageId: q.id,
        body: q.body,
        at: q.createdAt,
      });

    const pending = await ctx.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.status, "pending")));
    for (const a of pending) {
      const [m] =
        a.subjectKind === "mission"
          ? await ctx.db.select().from(missions).where(eq(missions.id, a.subjectId))
          : [];
      items.push({
        kind: "action",
        missionId: m?.id ?? null,
        mission: m?.title ?? null,
        approvalId: a.id,
        action: a.action,
        requestedBy: a.requestedBy,
        at: a.createdAt,
      });
    }

    items.sort((x, y) => x.at.getTime() - y.at.getTime());
    return { items, count: items.length };
  });
}
