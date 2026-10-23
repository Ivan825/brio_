import { schema } from "@brio/db";
import { fromNodeHeaders } from "better-auth/node";
import { and, eq, isNull } from "drizzle-orm";
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
}

export async function requireSession(ctx: AppContext, req: FastifyRequest): Promise<SessionInfo> {
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

/** The caller's role in a live (not soft-deleted) workspace, or 404 so membership is not leaked. */
export async function requireMember(
  ctx: AppContext,
  workspaceId: string,
  userId: string,
  allowed?: readonly Role[],
) {
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
  const id = (Array.isArray(header) ? header[0] : header) ?? session.activeWorkspaceId;
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
