import { randomBytes } from "node:crypto";
import { schema } from "@brio/db";
import { fromNodeHeaders } from "better-auth/node";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { forwardCookies, HttpError, one, requireMember, requireSession, requireSignedIn } from "../http";

const { apiTokens, invitations, members, runners, users, workspaces } = schema;

const Name = z.string().trim().min(1).max(80);
const Slug = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/, "lowercase letters, digits and dashes");
const CreateWorkspace = z.object({ name: Name, slug: Slug.optional() });
const UpdateWorkspace = z.object({ name: Name });
const Invite = z.object({ email: z.email(), role: z.enum(["admin", "member", "viewer"]).default("member") });
const ChangeRole = z.object({ role: z.enum(["owner", "admin", "member", "viewer"]) });
const MemberParams = z.object({ id: z.uuid(), userId: z.uuid() });
const Params = z.object({ id: z.uuid() });

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "workspace"}-${randomBytes(3).toString("hex")}`;
}

export async function workspaceRoutes(app: FastifyInstance, ctx: AppContext) {
  /** Workspaces the caller belongs to, with their role and which one is active. */
  app.get("/v1/workspaces", async (req) => {
    const s = await requireSession(ctx, req);
    const rows = await ctx.db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        plan: workspaces.plan,
        role: members.role,
      })
      .from(members)
      .innerJoin(workspaces, eq(workspaces.id, members.workspaceId))
      .where(
        and(
          eq(members.userId, s.userId),
          isNull(workspaces.deletedAt),
          // An API token sees only its own workspace.
          ...(s.tokenWorkspaceId ? [eq(workspaces.id, s.tokenWorkspaceId)] : []),
        ),
      )
      .orderBy(asc(workspaces.name));
    return {
      workspaces: rows.map((w) => ({ ...w, active: w.id === s.activeWorkspaceId })),
      activeWorkspaceId: s.activeWorkspaceId,
    };
  });

  /** Creates a workspace (Better Auth organisation), makes the caller owner and switches to it. */
  app.post("/v1/workspaces", async (req, reply) => {
    requireSignedIn(await requireSession(ctx, req), "create workspaces");
    const body = CreateWorkspace.parse(req.body);
    const { headers, response } = await ctx.auth.api.createOrganization({
      body: { name: body.name, slug: body.slug ?? slugify(body.name) },
      headers: fromNodeHeaders(req.headers),
      returnHeaders: true,
    });
    forwardCookies(reply, headers);
    if (!response) throw new HttpError(500, "workspace was not created");
    return reply
      .status(201)
      .send({ workspace: { id: response.id, name: response.name, slug: response.slug } });
  });

  app.patch("/v1/workspaces/:id", async (req) => {
    const s = await requireSession(ctx, req);
    const { id } = Params.parse(req.params);
    await requireMember(ctx, id, s, ["owner", "admin"]);
    const body = UpdateWorkspace.parse(req.body);
    const w = one(
      await ctx.db.update(workspaces).set({ name: body.name }).where(eq(workspaces.id, id)).returning(),
      "workspace",
    );
    return { workspace: { id: w.id, name: w.name, slug: w.slug } };
  });

  /** Soft delete: events and the ledger are append-only, so a workspace's history is kept. Owner only. */
  app.delete("/v1/workspaces/:id", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const { id } = Params.parse(req.params);
    requireSignedIn(s, "delete a workspace");
    await requireMember(ctx, id, s, ["owner"]);
    await ctx.db.update(workspaces).set({ deletedAt: new Date() }).where(eq(workspaces.id, id));
    await ctx.ledger.append(ctx.db, {
      workspaceId: id,
      kind: "policy.change",
      payload: { action: "workspace.deleted", by: s.userId },
    });
    return reply.status(204).send();
  });

  /** Switches the session's active workspace. */
  app.post("/v1/workspaces/:id/activate", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const { id } = Params.parse(req.params);
    requireSignedIn(s, "switch workspaces");
    await requireMember(ctx, id, s);
    const { headers } = await ctx.auth.api.setActiveOrganization({
      body: { organizationId: id },
      headers: fromNodeHeaders(req.headers),
      returnHeaders: true,
    });
    forwardCookies(reply, headers);
    return { activeWorkspaceId: id };
  });

  app.get("/v1/workspaces/:id/members", async (req) => {
    const s = await requireSession(ctx, req);
    const { id } = Params.parse(req.params);
    await requireMember(ctx, id, s);
    const rows = await ctx.db
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        role: members.role,
        joinedAt: members.createdAt,
      })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(eq(members.workspaceId, id))
      .orderBy(asc(members.createdAt));
    const pending = await ctx.db
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        expiresAt: invitations.expiresAt,
      })
      .from(invitations)
      .where(and(eq(invitations.workspaceId, id), eq(invitations.status, "pending")));
    return { members: rows, invitations: pending };
  });

  /** Invites by email. M0 "sends" by logging the email locally (see LogMailer). */
  app.post("/v1/workspaces/:id/invitations", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const { id } = Params.parse(req.params);
    requireSignedIn(s, "invite people");
    await requireMember(ctx, id, s, ["owner", "admin"]);
    const body = Invite.parse(req.body);
    const inv = await ctx.auth.api.createInvitation({
      body: { email: body.email, role: body.role, organizationId: id },
      headers: fromNodeHeaders(req.headers),
    });
    return reply
      .status(201)
      .send({ invitation: { id: inv.id, email: inv.email, role: inv.role, expiresAt: inv.expiresAt } });
  });

  /**
   * Changes a member's role (M9). Owners and admins change members and viewers; only an owner makes or unmakes owners
   * and admins; a workspace always keeps an owner. Recorded in the ledger.
   */
  app.patch("/v1/workspaces/:id/members/:userId", async (req) => {
    const s = await requireSession(ctx, req);
    requireSignedIn(s, "change roles");
    const { id, userId } = MemberParams.parse(req.params);
    const { role: mine } = await requireMember(ctx, id, s, ["owner", "admin"]);
    const { role } = ChangeRole.parse(req.body);
    const target = await memberOf(id, userId);
    const powerful = (r: string) => r === "owner" || r === "admin";
    if (mine !== "owner" && (powerful(target.role) || powerful(role)))
      throw new HttpError(403, "only an owner can make or unmake owners and admins", "owner_only");
    if (target.role === "owner" && role !== "owner") await keepAnOwner(id);
    await ctx.auth.api.updateMemberRole({
      body: { memberId: target.id, role, organizationId: id },
      headers: fromNodeHeaders(req.headers),
    });
    await ctx.ledger.append(ctx.db, {
      workspaceId: id,
      kind: "member.changed",
      payload: { userId, from: target.role, to: role, by: s.userId },
    });
    return { member: { userId, role } };
  });

  /** Removes a member (owners and admins; an admin cannot remove an owner or another admin; an owner always stays). */
  app.delete("/v1/workspaces/:id/members/:userId", async (req, reply) => {
    const s = await requireSession(ctx, req);
    requireSignedIn(s, "remove members");
    const { id, userId } = MemberParams.parse(req.params);
    const { role: mine } = await requireMember(ctx, id, s, ["owner", "admin"]);
    const target = await memberOf(id, userId);
    if (mine !== "owner" && (target.role === "owner" || target.role === "admin"))
      throw new HttpError(403, "only an owner can remove owners and admins", "owner_only");
    if (target.role === "owner") await keepAnOwner(id);
    await ctx.auth.api.removeMember({
      body: { memberIdOrEmail: target.id, organizationId: id },
      headers: fromNodeHeaders(req.headers),
    });
    const revoked = await revokeAccess(id, userId);
    await ctx.ledger.append(ctx.db, {
      workspaceId: id,
      kind: "member.changed",
      payload: { userId, from: target.role, removed: true, ...revoked, by: s.userId },
    });
    return reply.status(204).send();
  });

  /** Someone removed keeps nothing that acts in the workspace: their API tokens and local runners there are revoked. */
  async function revokeAccess(workspaceId: string, userId: string) {
    const now = new Date();
    const tokens = await ctx.db
      .update(apiTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(apiTokens.workspaceId, workspaceId),
          eq(apiTokens.userId, userId),
          isNull(apiTokens.revokedAt),
        ),
      )
      .returning({ id: apiTokens.id });
    const gone = await ctx.db
      .update(runners)
      .set({ revokedAt: now })
      .where(
        and(eq(runners.workspaceId, workspaceId), eq(runners.ownerId, userId), isNull(runners.revokedAt)),
      )
      .returning({ id: runners.id });
    for (const r of gone) ctx.runners.disconnect(r.id);
    return { tokensRevoked: tokens.length, runnersRevoked: gone.length };
  }

  async function memberOf(workspaceId: string, userId: string) {
    const [row] = await ctx.db
      .select({ id: members.id, role: members.role })
      .from(members)
      .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, userId)));
    if (!row) throw new HttpError(404, "member not found", "not_found");
    return row;
  }

  async function keepAnOwner(workspaceId: string) {
    const owners = await ctx.db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.workspaceId, workspaceId), eq(members.role, "owner")));
    if (owners.length < 2)
      throw new HttpError(409, "a workspace needs an owner: make someone else owner first", "last_owner");
  }
}
