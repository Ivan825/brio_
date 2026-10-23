// Approvals and deliveries (BUILD_PLAN M8, CLAUDE.md rule 6): a person approves or denies an action that waits on them
// (opening a pull request, pushing a branch); a member can ask again for a mission's delivery after one was denied
// or failed.
import { schema } from "@brio/db";
import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { decideApproval, presentDelivery, proposeDelivery } from "../deliveries";
import { HttpError, requireMember, requireSession, requireSignedIn, workspaceFor } from "../http";
import { loadMission } from "./missions";

const Params = z.object({ id: z.uuid() });
const Decide = z.object({
  decision: z.enum(["approve", "deny"]),
  reason: z.string().trim().max(2000).optional(),
});

export async function approvalRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post("/v1/approvals/:id/decide", async (req) => {
    const s = await requireSession(ctx, req);
    requireSignedIn(s, "decide approvals");
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s, ["owner", "admin", "member"]);
    const body = Decide.parse(req.body);
    const { approval, delivery } = await decideApproval(ctx, {
      approvalId: Params.parse(req.params).id,
      workspaceId,
      userId: s.userId,
      approve: body.decision === "approve",
      ...(body.reason ? { reason: body.reason } : {}),
    });
    return {
      approval: { id: approval.id, action: approval.action, status: approval.status },
      delivery: delivery ? presentDelivery(delivery) : null,
    };
  });

  app.get("/v1/missions/:id/deliveries", async (req) => {
    const s = await requireSession(ctx, req);
    const m = await loadMission(ctx.db, Params.parse(req.params).id);
    await requireMember(ctx, m.workspaceId, s);
    const rows = await ctx.db
      .select()
      .from(schema.deliveries)
      .where(eq(schema.deliveries.missionId, m.id))
      .orderBy(asc(schema.deliveries.createdAt));
    return { deliveries: rows.map(presentDelivery) };
  });

  /** Ask for a delivery again (the last one was denied or failed); it waits on an approval like the first. */
  app.post("/v1/missions/:id/deliveries", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const m = await loadMission(ctx.db, Params.parse(req.params).id);
    await requireMember(ctx, m.workspaceId, s, ["owner", "admin", "member"]);
    if (m.status !== "done") throw new HttpError(409, "only a finished mission can be delivered", "not_done");
    const d = await proposeDelivery(ctx, ctx.db, m, null, s.userId);
    if (!d)
      throw new HttpError(
        409,
        "nothing to deliver: the mission has no repository or integrated work, or a delivery is already open",
        "nothing_to_deliver",
      );
    return reply.status(201).send({ delivery: presentDelivery(d) });
  });
}
