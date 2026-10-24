// Policies (M9, SECURITY_GOVERNANCE §4): data routing by sensitivity, the connector allow-list, network rules and
// quick-start limits. Owners and admins write them; every change is in the ledger. They take effect at once: the
// router and every dispatch read them.
import { PolicyRule } from "@brio/core";
import { schema } from "@brio/db";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { HttpError, one, requireMember, requireSession, workspaceFor } from "../http";

const { policies } = schema;

const Create = z
  .object({ name: z.string().trim().min(1).max(120), enabled: z.boolean().default(true) })
  .and(PolicyRule);
const Update = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
});
const Params = z.object({ id: z.uuid() });

const present = (p: typeof policies.$inferSelect) => ({
  id: p.id,
  kind: p.kind,
  name: p.name,
  rule: p.rule,
  enabled: p.enabled,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

export async function policyRoutes(app: FastifyInstance, ctx: AppContext) {
  /** The workspace's policies (data routing, connector allow and deny lists, network, approvals). */
  app.get("/v1/policies", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s);
    const rows = await ctx.db
      .select()
      .from(policies)
      .where(eq(policies.workspaceId, workspaceId))
      .orderBy(asc(policies.createdAt));
    return { policies: rows.map(present) };
  });

  /** Adds a policy. */
  app.post("/v1/policies", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s, ["owner", "admin"]);
    const body = Create.parse(req.body);
    const row = one(
      await ctx.db
        .insert(policies)
        .values({
          workspaceId,
          kind: body.kind,
          name: body.name,
          rule: body.rule as Record<string, unknown>,
          enabled: body.enabled,
        })
        .returning(),
      "policy",
    );
    await ctx.ledger.append(ctx.db, {
      workspaceId,
      kind: "policy.change",
      payload: {
        policyId: row.id,
        change: "created",
        kind: row.kind,
        name: row.name,
        rule: row.rule,
        by: s.userId,
      },
    });
    return reply.status(201).send({ policy: present(row) });
  });

  /** Changes or disables a policy. */
  app.patch("/v1/policies/:id", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s, ["owner", "admin"]);
    const body = Update.parse(req.body);
    const [row] = await ctx.db
      .update(policies)
      .set(body)
      .where(and(eq(policies.id, Params.parse(req.params).id), eq(policies.workspaceId, workspaceId)))
      .returning();
    if (!row) throw new HttpError(404, "policy not found", "not_found");
    await ctx.ledger.append(ctx.db, {
      workspaceId,
      kind: "policy.change",
      payload: { policyId: row.id, change: "updated", ...body, by: s.userId },
    });
    return { policy: present(row) };
  });

  /** Removes a policy. */
  app.delete("/v1/policies/:id", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s, ["owner", "admin"]);
    const [row] = await ctx.db
      .delete(policies)
      .where(and(eq(policies.id, Params.parse(req.params).id), eq(policies.workspaceId, workspaceId)))
      .returning();
    if (!row) throw new HttpError(404, "policy not found", "not_found");
    await ctx.ledger.append(ctx.db, {
      workspaceId,
      kind: "policy.change",
      payload: { policyId: row.id, change: "deleted", kind: row.kind, name: row.name, by: s.userId },
    });
    return reply.status(204).send();
  });
}
