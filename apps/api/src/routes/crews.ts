// Crews (PRD glossary): a saved set of agents and routing preferences ("my coding crew"). A mission routed to a crew
// uses only its agents, and the crew's preferred agent for a task type unless the plan pins another.
import { schema } from "@brio/db";
import { TaskType } from "@brio/schema";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { HttpError, one, requireMember, requireSession, workspaceFor } from "../http";

const { agents, crews } = schema;

const CrewBody = z.object({
  name: z.string().trim().min(1).max(80),
  agentIds: z.array(z.uuid()).min(1).max(50),
  /** The crew's agent for a task type. */
  pins: z.partialRecord(TaskType, z.uuid()).default({}),
});
const Params = z.object({ id: z.uuid() });

type Crew = typeof crews.$inferSelect;
const present = (c: Crew) => ({
  id: c.id,
  name: c.name,
  agentIds: c.agentIds,
  pins: c.routingPrefs.pins ?? {},
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

export async function crewRoutes(app: FastifyInstance, ctx: AppContext) {
  /** Every agent and pin must be one of the workspace's live agents, and every pin one of the crew's. */
  async function check(workspaceId: string, body: z.infer<typeof CrewBody>) {
    const ids = [...new Set(body.agentIds)];
    const rows = await ctx.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), inArray(agents.id, ids), isNull(agents.deletedAt)));
    if (rows.length !== ids.length)
      throw new HttpError(422, "every agent must be in this workspace", "unknown_agent");
    for (const [type, agentId] of Object.entries(body.pins))
      if (!ids.includes(agentId as string))
        throw new HttpError(422, `the agent for ${type} must be in the crew`, "pin_outside_crew");
    return ids;
  }

  async function load(workspaceId: string, id: string) {
    const [c] = await ctx.db
      .select()
      .from(crews)
      .where(and(eq(crews.id, id), eq(crews.workspaceId, workspaceId), isNull(crews.deletedAt)));
    if (!c) throw new HttpError(404, "crew not found", "not_found");
    return c;
  }

  app.get("/v1/crews", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s);
    const rows = await ctx.db
      .select()
      .from(crews)
      .where(and(eq(crews.workspaceId, workspaceId), isNull(crews.deletedAt)))
      .orderBy(asc(crews.createdAt));
    return { crews: rows.map(present) };
  });

  app.post("/v1/crews", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s, ["owner", "admin", "member"]);
    const body = CrewBody.parse(req.body);
    const agentIds = await check(workspaceId, body);
    const row = one(
      await ctx.db
        .insert(crews)
        .values({
          workspaceId,
          name: body.name,
          agentIds,
          routingPrefs: { pins: body.pins as Record<string, string> },
        })
        .returning(),
      "crew",
    );
    return reply.status(201).send({ crew: present(row) });
  });

  app.put("/v1/crews/:id", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s, ["owner", "admin", "member"]);
    const c = await load(workspaceId, Params.parse(req.params).id);
    const body = CrewBody.parse(req.body);
    const agentIds = await check(workspaceId, body);
    const row = one(
      await ctx.db
        .update(crews)
        .set({ name: body.name, agentIds, routingPrefs: { pins: body.pins as Record<string, string> } })
        .where(eq(crews.id, c.id))
        .returning(),
      "crew",
    );
    return { crew: present(row) };
  });

  app.delete("/v1/crews/:id", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s, ["owner", "admin", "member"]);
    const c = await load(workspaceId, Params.parse(req.params).id);
    await ctx.db.update(crews).set({ deletedAt: new Date() }).where(eq(crews.id, c.id));
    return reply.status(204).send();
  });
}
