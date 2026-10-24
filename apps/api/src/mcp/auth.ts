// Who is calling /mcp: a workspace API token (brio_pat_…), or an OAuth access token Brio issued to a remote MCP client
// (a JWT bound to this server's /mcp, checked against Brio's own signing keys, issuer and audience). An OAuth caller
// acts in the workspace it names (x-brio-workspace), else its most recently active one. Anything else gets the 401
// challenge that points MCP clients at the protected resource metadata, so they can start signing in.
import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { schema } from "@brio/db";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { createLocalJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import { APPROVE_SCOPE, MCP_SCOPE, mcpResource } from "../auth";
import type { AppContext } from "../context";
import { HttpError, requireSession, TOKEN_PREFIX } from "../http";
import type { Caller } from "./tools";

/** The challenge MCP clients follow to discover how to sign in (RFC 9728 §5.1). */
export const mcpChallenge = (appUrl: string) =>
  `Bearer resource_metadata="${appUrl.replace(/\/+$/, "")}/.well-known/oauth-protected-resource/mcp", scope="${MCP_SCOPE}"`;

export class McpAuthError extends HttpError {
  constructor(message: string) {
    super(401, message, "unauthenticated");
  }
}

export function mcpAuthenticator(ctx: AppContext) {
  const origin = ctx.config.APP_URL.replace(/\/+$/, "");
  let keys: { get: JWTVerifyGetKey; until: number } | null = null;
  let issuer: string | null = null;

  const verifier = async () => {
    if (!keys || keys.until < Date.now()) {
      const res = await ctx.auth.handler(new Request(`${origin}/api/auth/jwks`));
      keys = { get: createLocalJWKSet((await res.json()) as { keys: [] }), until: Date.now() + 5 * 60_000 };
    }
    if (!issuer) {
      const meta = await oauthProviderAuthServerMetadata(ctx.auth)(
        new Request(`${origin}/.well-known/oauth-authorization-server/api/auth`),
      );
      issuer = ((await meta.json()) as { issuer: string }).issuer;
    }
    return { keys: keys.get, issuer };
  };

  return async (req: FastifyRequest): Promise<Caller> => {
    const client = String(req.headers["user-agent"] ?? "mcp client").slice(0, 80);
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!bearer) throw new McpAuthError("sign in: this MCP server needs an access token");
    if (bearer.startsWith(TOKEN_PREFIX)) {
      const session = await requireSession(ctx, req);
      return { session, workspaceId: session.tokenWorkspaceId as string, client, canApprove: false };
    }

    // An OAuth access token: Brio's signature, Brio's issuer, this /mcp as its audience, not expired.
    const v = await verifier();
    let sub: string;
    let scopes: string[] = [];
    try {
      const { payload } = await jwtVerify(bearer, v.keys, {
        issuer: v.issuer,
        audience: mcpResource(origin),
      });
      if (!payload.sub) throw new Error("no subject");
      sub = payload.sub;
      scopes = String(payload.scope ?? "")
        .split(" ")
        .filter(Boolean);
    } catch {
      // A key rotation would show up here once; read the keys again next time.
      keys = null;
      throw new McpAuthError("the access token is not valid for this server");
    }
    const [user] = await ctx.db.select().from(schema.users).where(eq(schema.users.id, sub));
    if (!user) throw new McpAuthError("the access token's user no longer exists");

    const asked = req.headers["x-brio-workspace"];
    const wanted = Array.isArray(asked) ? asked[0] : asked;
    const memberships = await ctx.db
      .select({ workspaceId: schema.members.workspaceId })
      .from(schema.members)
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.members.workspaceId))
      .where(and(eq(schema.members.userId, user.id), isNull(schema.workspaces.deletedAt)));
    const ids = new Set(memberships.map((m) => m.workspaceId));
    let workspaceId = wanted && ids.has(wanted) ? wanted : null;
    if (wanted && !workspaceId)
      throw new HttpError(403, "you are not a member of that workspace", "forbidden");
    if (!workspaceId) {
      const [recent] = await ctx.db
        .select({ ws: schema.sessions.activeWorkspaceId })
        .from(schema.sessions)
        .where(and(eq(schema.sessions.userId, user.id), isNotNull(schema.sessions.activeWorkspaceId)))
        .orderBy(desc(schema.sessions.updatedAt))
        .limit(1);
      workspaceId = recent?.ws && ids.has(recent.ws) ? recent.ws : (memberships[0]?.workspaceId ?? null);
    }
    if (!workspaceId)
      throw new HttpError(403, "create a workspace in the Brio web app first", "no_workspace");
    return {
      // Held to that workspace on every call, as an API token is.
      session: {
        userId: user.id,
        email: user.email,
        name: user.name,
        activeWorkspaceId: workspaceId,
        tokenWorkspaceId: workspaceId,
      },
      workspaceId,
      client,
      // Only when the person granted it on the consent page.
      canApprove: scopes.includes(APPROVE_SCOPE),
    };
  };
}
