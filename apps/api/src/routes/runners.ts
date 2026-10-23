// Local runners (BUILD_PLAN M8): a person registers their machine for a workspace (`brio runner register`), gets a
// token shown once, and starts the daemon with it. Host mode — no container — needs the owner's explicit consent,
// recorded with its words and time. Agents and projects are then bound to the runner.
import { randomBytes } from "node:crypto";
import { schema } from "@brio/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { HttpError, one, requireMember, requireSession, requireSignedIn, workspaceFor } from "../http";
import { RUNNER_TOKEN_PREFIX, runnerTokenHash } from "../runners/hub";

const { runners } = schema;

/** What a person agrees to for host mode; stored with their consent. */
export const HOST_MODE_CONSENT =
  "Agents on this runner run as me, on this machine, without a container: in a fresh git worktree, with my CLIs' own sign-ins, " +
  "no network allowlist and no CPU or memory cap. I only bind agents and projects I trust to it.";

const Register = z.object({
  name: z.string().trim().min(1).max(80),
  mode: z.enum(["docker", "host"]).default("docker"),
  /** Host mode only: the person accepts HOST_MODE_CONSENT. */
  acceptHostMode: z.literal(true).optional(),
});
const Params = z.object({ id: z.uuid() });

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const newToken = () => RUNNER_TOKEN_PREFIX + [...randomBytes(40)].map((b) => BASE62[b % 62]).join("");

export async function runnerRoutes(app: FastifyInstance, ctx: AppContext) {
  const present = (r: typeof runners.$inferSelect) => ({
    id: r.id,
    name: r.name,
    mode: r.mode,
    ownerId: r.ownerId,
    prefix: r.tokenPrefix,
    consent: r.consent,
    capabilities: r.capabilities,
    online: ctx.runners.isOnline(r.id),
    lastSeenAt: r.lastSeenAt,
    createdAt: r.createdAt,
  });

  app.get("/v1/runners", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s);
    const rows = await ctx.db
      .select()
      .from(runners)
      .where(and(eq(runners.workspaceId, workspaceId), isNull(runners.revokedAt)))
      .orderBy(desc(runners.createdAt));
    return { runners: rows.map(present), hostModeConsent: HOST_MODE_CONSENT };
  });

  app.post("/v1/runners", async (req, reply) => {
    const s = await requireSession(ctx, req);
    requireSignedIn(s, "register runners");
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s, ["owner", "admin", "member"]);
    const body = Register.parse(req.body);
    if (body.mode === "host" && !body.acceptHostMode)
      throw new HttpError(422, `host mode needs your consent: ${HOST_MODE_CONSENT}`, "consent_required");
    const token = newToken();
    const row = one(
      await ctx.db
        .insert(runners)
        .values({
          workspaceId,
          ownerId: s.userId,
          name: body.name,
          tokenHash: runnerTokenHash(token),
          tokenPrefix: token.slice(0, RUNNER_TOKEN_PREFIX.length + 4),
          mode: body.mode,
          consent:
            body.mode === "host"
              ? { host: { by: s.userId, at: new Date().toISOString(), text: HOST_MODE_CONSENT } }
              : null,
        })
        .returning(),
      "runner",
    );
    await ctx.ledger.append(ctx.db, {
      workspaceId,
      kind: "key.added",
      payload: { runnerId: row.id, name: row.name, mode: row.mode, prefix: row.tokenPrefix, by: s.userId },
    });
    return reply.status(201).send({ runner: present(row), token });
  });

  /** Revoking stops the runner at once: its connection is refused from the next hello on. */
  app.delete("/v1/runners/:id", async (req, reply) => {
    const s = await requireSession(ctx, req);
    requireSignedIn(s, "revoke runners");
    const workspaceId = workspaceFor(req, s);
    const { role } = await requireMember(ctx, workspaceId, s, ["owner", "admin", "member"]);
    const [r] = await ctx.db
      .select()
      .from(runners)
      .where(and(eq(runners.id, Params.parse(req.params).id), eq(runners.workspaceId, workspaceId)));
    if (!r || r.revokedAt) throw new HttpError(404, "runner not found", "not_found");
    if (r.ownerId !== s.userId && role !== "owner" && role !== "admin")
      throw new HttpError(403, "only its owner or a workspace admin can revoke a runner", "forbidden");
    await ctx.db.update(runners).set({ revokedAt: new Date() }).where(eq(runners.id, r.id));
    ctx.runners.disconnect(r.id);
    await ctx.ledger.append(ctx.db, {
      workspaceId,
      kind: "key.removed",
      payload: { runnerId: r.id, name: r.name, by: s.userId },
    });
    return reply.status(204).send();
  });
}
