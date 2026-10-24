// Connecting the workspace's Mandate (D-07): its URL and one mandate's agent token, checked with Mandate and kept in
// the vault. From then on every paid attempt asks that mandate first (see ../mandate.ts).
import { schema } from "@brio/db";
import { and, desc, eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { HttpError, requireMember, requireSession, requireSignedIn, workspaceFor } from "../http";
import { MandateClient, mandateClientFor } from "../mandate";

const { mandateConnections, mandateHolds, tasks } = schema;

const Connect = z.object({
  baseUrl: z.url().max(500),
  token: z
    .string()
    .trim()
    .regex(/^mnd_[A-Za-z0-9_-]{16,200}$/, "a Mandate agent token starts with mnd_"),
});

export async function mandateRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/v1/integrations/mandate", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s);
    const [conn] = await ctx.db
      .select()
      .from(mandateConnections)
      .where(eq(mandateConnections.workspaceId, workspaceId));
    if (!conn) return { mandate: { connected: false } };
    // Live state when Mandate answers; the connection stands either way.
    const m = await mandateClientFor(ctx, ctx.db, workspaceId);
    const live = await m?.client.mandate().catch((e: Error) => ({ error: e.message }));
    const holds = await ctx.db
      .select({ h: mandateHolds, taskTitle: tasks.title, missionId: tasks.missionId })
      .from(mandateHolds)
      .innerJoin(tasks, eq(tasks.id, mandateHolds.taskId))
      .where(eq(mandateHolds.workspaceId, workspaceId))
      .orderBy(desc(mandateHolds.createdAt))
      .limit(20);
    return {
      mandate: {
        connected: true,
        baseUrl: conn.baseUrl,
        mandateId: conn.mandateId,
        name: conn.name,
        currency: conn.currency,
        live:
          live && "error" in live
            ? { reachable: false, error: live.error }
            : live
              ? {
                  reachable: true,
                  status: live.status,
                  frozen: live.frozen ?? false,
                  remaining: live.remaining ?? null,
                  pendingApprovals: live.pendingApprovals ?? 0,
                }
              : null,
        holds: holds.map(({ h, taskTitle, missionId }) => ({
          id: h.id,
          taskId: h.taskId,
          missionId,
          taskTitle,
          attemptId: h.attemptId,
          status: h.status,
          amountCents: h.amountCents,
          capturedCents: h.capturedCents,
          merchant: h.merchant,
          reason: h.reason,
          createdAt: h.createdAt,
        })),
      },
    };
  });

  app.put("/v1/integrations/mandate", async (req) => {
    const s = await requireSession(ctx, req);
    requireSignedIn(s, "connect Mandate");
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s, ["owner", "admin"]);
    const body = Connect.parse(req.body);
    await ctx.checkUrl(body.baseUrl).catch((e: Error) => {
      throw new HttpError(422, e.message, "unsafe_url");
    });
    const view = await new MandateClient({ baseUrl: body.baseUrl, token: body.token, fetch: ctx.fetch })
      .mandate()
      .catch((e: Error) => {
        throw new HttpError(422, `Mandate refused the token: ${e.message}`, "mandate_refused");
      });
    if (view.status !== "active")
      throw new HttpError(422, `that mandate is ${view.status}, not active`, "mandate_inactive");
    // Brio meters in US dollars; a mandate in another currency would be asked for amounts it does not mean.
    if (view.currency.toUpperCase() !== "USD")
      throw new HttpError(422, `that mandate is in ${view.currency}; Brio spends in USD`, "mandate_currency");
    const name = view.mandate?.name ?? view.mandateId;
    await ctx.db.transaction(async (tx) => {
      const secret = await ctx.vault.put(tx, {
        workspaceId,
        label: `mandate:${workspaceId}:${Date.now()}`,
        value: body.token,
        createdBy: s.userId,
      });
      await tx
        .insert(mandateConnections)
        .values({
          workspaceId,
          baseUrl: body.baseUrl,
          tokenRef: secret.id,
          mandateId: view.mandateId,
          name,
          currency: view.currency.toUpperCase(),
          connectedBy: s.userId,
        })
        .onConflictDoUpdate({
          target: mandateConnections.workspaceId,
          set: {
            baseUrl: body.baseUrl,
            tokenRef: secret.id,
            mandateId: view.mandateId,
            name,
            currency: view.currency.toUpperCase(),
            connectedBy: s.userId,
          },
        });
      await ctx.ledger.append(tx, {
        workspaceId,
        kind: "key.added",
        payload: {
          mandate: { baseUrl: body.baseUrl, mandateId: view.mandateId, sandbox: view.sandbox ?? false },
          secret: secret.id,
          by: s.userId,
        },
      });
    });
    return { mandate: { connected: true, baseUrl: body.baseUrl, mandateId: view.mandateId, name } };
  });

  /** Disconnects: attempts stop asking Mandate. Requests still waiting are dropped; their tasks are freed. */
  app.delete("/v1/integrations/mandate", async (req, reply) => {
    const s = await requireSession(ctx, req);
    requireSignedIn(s, "disconnect Mandate");
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s, ["owner", "admin"]);
    const freed = await ctx.db.transaction(async (tx) => {
      const [gone] = await tx
        .delete(mandateConnections)
        .where(eq(mandateConnections.workspaceId, workspaceId))
        .returning();
      if (!gone) return [];
      await tx
        .update(mandateHolds)
        .set({ status: "declined", reason: "Mandate was disconnected" })
        .where(and(eq(mandateHolds.workspaceId, workspaceId), inArray(mandateHolds.status, ["pending"])));
      await ctx.ledger.append(tx, {
        workspaceId,
        kind: "key.removed",
        payload: { mandate: { mandateId: gone.mandateId }, secret: gone.tokenRef, by: s.userId },
      });
      return tx
        .update(tasks)
        .set({ status: "ready", blockedReason: null })
        .where(
          and(
            eq(tasks.workspaceId, workspaceId),
            eq(tasks.status, "blocked"),
            like(tasks.blockedReason, "dispatch: mandate:%"),
          ),
        )
        .returning({ missionId: tasks.missionId });
    });
    for (const missionId of new Set(freed.map((t) => t.missionId))) ctx.orchestrator.schedule(missionId);
    return reply.status(204).send();
  });
}
