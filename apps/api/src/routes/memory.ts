// Project memory for people (PRD F32, M9): what Brio remembers about a project — view and search it, add a preference
// or fact, correct an item, or forget it (its links go with it). Every change by a person is in the ledger. And the
// brief an agent would get for some files or a topic.

import { schema } from "@brio/db";
import { brief } from "@brio/memory";
import { and, desc, eq, ilike, isNull, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { HttpError, one, requireMember, requireSession, workspaceFor } from "../http";
import { requireRunnerOwner } from "../runner-owner";

const { memoryEdges, memoryNodes, projects } = schema;

const Params = z.object({ id: z.uuid() });
const List = z.object({
  kind: z.enum(["decision", "contract", "file", "preference", "fact", "task", "agent", "prompt"]).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
const Add = z.object({
  kind: z.enum(["preference", "fact", "decision"]),
  title: z.string().trim().min(1).max(300),
  body: z.string().max(4000).default(""),
});
const Edit = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  body: z.string().max(4000).optional(),
});
const BriefQuery = z.object({
  paths: z
    .string()
    .optional()
    .transform((s) =>
      s
        ? s
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean)
        : [],
    ),
  topic: z.string().trim().max(300).optional(),
});

const present = (n: typeof memoryNodes.$inferSelect, links = 0) => ({
  id: n.id,
  kind: n.kind,
  title: n.title,
  body: n.body,
  ref: n.ref,
  links,
  createdAt: n.createdAt,
  updatedAt: n.updatedAt,
});

export async function memoryRoutes(app: FastifyInstance, ctx: AppContext) {
  const projectFor = async (
    req: Parameters<typeof requireSession>[1],
    roles?: Array<"owner" | "admin" | "member">,
  ) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s, roles);
    const [p] = await ctx.db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.id, Params.parse(req.params).id),
          eq(projects.workspaceId, workspaceId),
          isNull(projects.deletedAt),
        ),
      );
    if (!p) throw new HttpError(404, "project not found", "not_found");
    return { s, workspaceId, project: p };
  };
  const nodeFor = async (req: Parameters<typeof requireSession>[1]) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s, ["owner", "admin", "member"]);
    const [n] = await ctx.db
      .select()
      .from(memoryNodes)
      .where(and(eq(memoryNodes.id, Params.parse(req.params).id), eq(memoryNodes.workspaceId, workspaceId)));
    if (!n) throw new HttpError(404, "memory item not found", "not_found");
    return { s, workspaceId, node: n };
  };

  /** What a project remembers, by kind (decisions, contracts, prompts, files, preferences). */
  app.get("/v1/projects/:id/memory", async (req) => {
    const { project } = await projectFor(req);
    const q = List.parse(req.query);
    const rows = await ctx.db
      .select()
      .from(memoryNodes)
      .where(
        and(
          eq(memoryNodes.projectId, project.id),
          ...(q.kind ? [eq(memoryNodes.kind, q.kind)] : []),
          ...(q.q ? [or(ilike(memoryNodes.title, `%${q.q}%`), ilike(memoryNodes.body, `%${q.q}%`))] : []),
        ),
      )
      .orderBy(desc(memoryNodes.updatedAt))
      .limit(q.limit);
    return { items: rows.map((n) => present(n)) };
  });

  /** The brief for paths (`?paths=`) or a topic (`?topic=`): the decisions, contracts and prompts behind them. */
  app.get("/v1/projects/:id/brief", async (req) => {
    const { project } = await projectFor(req);
    const q = BriefQuery.parse(req.query);
    return brief(ctx.db, project.id, { paths: q.paths, ...(q.topic ? { topic: q.topic } : {}) });
  });

  /** Adds something for the project to remember (a preference, a decision). */
  app.post("/v1/projects/:id/memory", async (req, reply) => {
    const { s, workspaceId, project } = await projectFor(req, ["owner", "admin", "member"]);
    // What a project remembers goes into every prompt there: on someone's machine, only they add to it.
    await requireRunnerOwner(ctx.db, project.id, s.userId, "add to what the project remembers");
    const body = Add.parse(req.body);
    const row = one(
      await ctx.db
        .insert(memoryNodes)
        .values({ workspaceId, projectId: project.id, kind: body.kind, title: body.title, body: body.body })
        .returning(),
      "memory",
    );
    await ctx.ledger.append(ctx.db, {
      workspaceId,
      kind: "memory.change",
      payload: {
        change: "added",
        nodeId: row.id,
        projectId: project.id,
        kind: row.kind,
        title: row.title,
        by: s.userId,
      },
    });
    return reply.status(201).send({ item: present(row) });
  });

  /** Corrects a remembered item. */
  app.patch("/v1/memory/:id", async (req) => {
    const { s, workspaceId, node } = await nodeFor(req);
    await requireRunnerOwner(ctx.db, node.projectId, s.userId, "change what the project remembers");
    const body = Edit.parse(req.body);
    const [row] = await ctx.db
      .update(memoryNodes)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(memoryNodes.id, node.id))
      .returning();
    await ctx.ledger.append(ctx.db, {
      workspaceId,
      kind: "memory.change",
      payload: {
        change: "edited",
        nodeId: node.id,
        before: { title: node.title },
        after: body,
        by: s.userId,
      },
    });
    return { item: present(row ?? node) };
  });

  /** Forgets an item: it and its links are gone, and no brief carries it again. */
  app.delete("/v1/memory/:id", async (req, reply) => {
    const { s, workspaceId, node } = await nodeFor(req);
    await ctx.db.transaction(async (tx) => {
      await tx.delete(memoryEdges).where(or(eq(memoryEdges.fromId, node.id), eq(memoryEdges.toId, node.id)));
      await tx.delete(memoryNodes).where(eq(memoryNodes.id, node.id));
      await ctx.ledger.append(tx, {
        workspaceId,
        kind: "memory.change",
        payload: { change: "forgotten", nodeId: node.id, kind: node.kind, title: node.title, by: s.userId },
      });
    });
    return reply.status(204).send();
  });
}
