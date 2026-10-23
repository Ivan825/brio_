import { createHash } from "node:crypto";
import { schema } from "@brio/db";
import { fromNodeHeaders } from "better-auth/node";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "./context";

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code = "error",
  ) {
    super(message);
  }
}

export interface SessionInfo {
  userId: string;
  email: string;
  name: string;
  activeWorkspaceId: string | null;
  /** Set when the caller is an API token: it acts in this workspace only. */
  tokenWorkspaceId?: string;
}

/** API tokens: `brio_pat_` and 40 base62 characters (shown once; only the sha256 is stored). */
export const TOKEN_PREFIX = "brio_pat_";
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** The person an API token acts for, in its one workspace, or null when the token is unknown, revoked or expired. */
export async function tokenSession(ctx: AppContext, token: string): Promise<SessionInfo | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const now = new Date();
  const [row] = await ctx.db
    .select({ token: schema.apiTokens, user: schema.users })
    .from(schema.apiTokens)
    .innerJoin(schema.users, eq(schema.users.id, schema.apiTokens.userId))
    .where(
      and(
        eq(schema.apiTokens.tokenHash, tokenHash(token)),
        isNull(schema.apiTokens.revokedAt),
        or(isNull(schema.apiTokens.expiresAt), gt(schema.apiTokens.expiresAt, now)),
      ),
    );
  if (!row) return null;
  // Recorded at most once a minute, so a busy client does not write on every call.
  if (!row.token.lastUsedAt || now.getTime() - row.token.lastUsedAt.getTime() > 60_000)
    await ctx.db
      .update(schema.apiTokens)
      .set({ lastUsedAt: now })
      .where(eq(schema.apiTokens.id, row.token.id));
  return {
    userId: row.user.id,
    email: row.user.email,
    name: row.user.name,
    activeWorkspaceId: row.token.workspaceId,
    tokenWorkspaceId: row.token.workspaceId,
  };
}

/** Refuses API tokens for what only a signed-in person may do (workspaces, members, tokens themselves). */
export function requireSignedIn(s: SessionInfo, what: string): void {
  if (s.tokenWorkspaceId)
    throw new HttpError(403, `an API token cannot ${what}: sign in to the web app`, "token_not_allowed");
}

export async function requireSession(ctx: AppContext, req: FastifyRequest): Promise<SessionInfo> {
  const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
  if (bearer?.startsWith(TOKEN_PREFIX)) {
    const t = await tokenSession(ctx, bearer);
    if (!t) throw new HttpError(401, "the API token is unknown, revoked or expired", "bad_token");
    return t;
  }
  const s = await ctx.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!s) throw new HttpError(401, "sign in first", "unauthenticated");
  const session = s.session as typeof s.session & { activeOrganizationId?: string | null };
  return {
    userId: s.user.id,
    email: s.user.email,
    name: s.user.name,
    activeWorkspaceId: session.activeOrganizationId ?? null,
  };
}

export type Role = "owner" | "admin" | "member" | "viewer";

/**
 * The caller's role in a live (not soft-deleted) workspace, or 404 so membership is not leaked. An API token is held to
 * its own workspace here, whichever way a route found the workspace (a mission's, a task's).
 */
export async function requireMember(
  ctx: AppContext,
  workspaceId: string,
  who: SessionInfo,
  allowed?: readonly Role[],
) {
  if (who.tokenWorkspaceId && who.tokenWorkspaceId !== workspaceId)
    throw new HttpError(404, "workspace not found", "not_found");
  const userId = who.userId;
  const [row] = await ctx.db
    .select({ role: schema.members.role, workspace: schema.workspaces })
    .from(schema.members)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.members.workspaceId))
    .where(
      and(
        eq(schema.members.workspaceId, workspaceId),
        eq(schema.members.userId, userId),
        isNull(schema.workspaces.deletedAt),
      ),
    );
  if (!row) throw new HttpError(404, "workspace not found", "not_found");
  if (allowed && !allowed.includes(row.role))
    throw new HttpError(403, `needs role ${allowed.join(" or ")}`, "forbidden");
  return row;
}

/** The workspace a request acts in: the x-brio-workspace header, else the session's active workspace. */
export function workspaceFor(req: FastifyRequest, session: SessionInfo): string {
  const header = req.headers["x-brio-workspace"];
  const asked = Array.isArray(header) ? header[0] : header;
  if (session.tokenWorkspaceId) {
    if (asked && asked !== session.tokenWorkspaceId)
      throw new HttpError(403, "this API token belongs to another workspace", "wrong_workspace");
    return session.tokenWorkspaceId;
  }
  const id = asked ?? session.activeWorkspaceId;
  if (!id) throw new HttpError(400, "no active workspace: create or switch to one", "no_workspace");
  return id;
}

/** Copies a Better Auth Response (status, headers incl. every Set-Cookie, body) onto a Fastify reply. */
export async function sendFetchResponse(reply: FastifyReply, res: Response): Promise<FastifyReply> {
  reply.status(res.status);
  res.headers.forEach((value, key) => {
    if (key !== "set-cookie" && key !== "content-length") reply.header(key, value);
  });
  const cookies = res.headers.getSetCookie();
  if (cookies.length) reply.header("set-cookie", cookies);
  return reply.send(res.body ? Buffer.from(await res.arrayBuffer()) : null);
}

export function forwardCookies(reply: FastifyReply, headers: Headers | undefined): void {
  const cookies = headers?.getSetCookie() ?? [];
  if (cookies.length) reply.header("set-cookie", cookies);
}

/** The single row an INSERT/UPDATE ... RETURNING produced; a missing row is a 404, not a crash. */
export function one<T>(rows: T[], what: string): T {
  const [row] = rows;
  if (row === undefined) throw new HttpError(404, `${what} not found`, "not_found");
  return row;
}
