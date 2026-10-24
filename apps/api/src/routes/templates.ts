// Templates (PRD F5): a plan saved as a reusable pipeline ("Research → memo → deck"). Saved from a mission's plan or
// written directly; a new mission starts from one, adapted to its goal by the planner or proposed as is.
import { lintPlan } from "@brio/core";
import { schema } from "@brio/db";
import { PlanGraph } from "@brio/schema";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { HttpError, one, requireMember, requireSession, workspaceFor } from "../http";

const { missions, plans, templates } = schema;

const CreateTemplate = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(2000).default(""),
    /** Save a mission's plan: its latest version, or the one named. */
    fromMission: z
      .object({ missionId: z.uuid(), version: z.number().int().positive().optional() })
      .optional(),
    graph: PlanGraph.optional(),
  })
  .refine((b) => Boolean(b.fromMission) !== Boolean(b.graph), "give either fromMission or graph");
const Params = z.object({ id: z.uuid() });

type Template = typeof templates.$inferSelect;
const present = (t: Template) => ({
  id: t.id,
  name: t.name,
  description: t.description,
  graph: t.graph,
  tasks: t.graph.tasks.map((x) => ({ key: x.key, type: x.type, title: x.title, dependsOn: x.dependsOn })),
  source: t.source,
  createdAt: t.createdAt,
});

export async function templateRoutes(app: FastifyInstance, ctx: AppContext) {
  /** The workspace's mission templates. */
  app.get("/v1/templates", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s);
    const rows = await ctx.db
      .select()
      .from(templates)
      .where(and(eq(templates.workspaceId, workspaceId), isNull(templates.deletedAt)))
      .orderBy(asc(templates.name));
    return { templates: rows.map(present) };
  });

  /** Saves a template: a mission's plan (`fromMission`) or a plan given (`graph`). */
  app.post("/v1/templates", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s, ["owner", "admin", "member"]);
    const body = CreateTemplate.parse(req.body);
    let graph = body.graph;
    let source: Template["source"] = null;
    if (body.fromMission) {
      const [m] = await ctx.db
        .select()
        .from(missions)
        .where(and(eq(missions.id, body.fromMission.missionId), eq(missions.workspaceId, workspaceId)));
      if (!m) throw new HttpError(404, "mission not found", "not_found");
      const [p] = await ctx.db
        .select()
        .from(plans)
        .where(
          and(
            eq(plans.missionId, m.id),
            ...(body.fromMission.version ? [eq(plans.version, body.fromMission.version)] : []),
          ),
        )
        .orderBy(desc(plans.version))
        .limit(1);
      if (!p) throw new HttpError(404, "the mission has no such plan", "not_found");
      graph = p.graph;
      source = { missionId: m.id, version: p.version };
    }
    const lint = lintPlan(graph as PlanGraph);
    if (lint.errors.length)
      throw new HttpError(
        422,
        `the plan has errors: ${lint.errors.map((e) => e.message).join("; ")}`,
        "plan_has_errors",
      );
    const row = one(
      await ctx.db
        .insert(templates)
        .values({
          workspaceId,
          name: body.name,
          description: body.description,
          // Saved without its questions: they were about the mission it came from.
          graph: { ...lint.graph, questions: [] },
          source,
          createdBy: s.userId,
        })
        .returning(),
      "template",
    );
    return reply.status(201).send({ template: present(row) });
  });

  /** Removes a template. */
  app.delete("/v1/templates/:id", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s, ["owner", "admin", "member"]);
    const [t] = await ctx.db
      .update(templates)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(templates.id, Params.parse(req.params).id),
          eq(templates.workspaceId, workspaceId),
          isNull(templates.deletedAt),
        ),
      )
      .returning();
    if (!t) throw new HttpError(404, "template not found", "not_found");
    return reply.status(204).send();
  });
}
