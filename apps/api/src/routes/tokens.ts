// API tokens (M7): a person makes one for a workspace in the web app and gives it to the brio CLI, its stdio MCP server
// or an A2A client. The token is shown once; Brio keeps its sha256. Only a signed-in person (never a token) makes or
// revokes tokens, and only their own.
import { randomBytes } from "node:crypto";
import { schema } from "@brio/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import {
  HttpError,
  one,
  requireMember,
  requireSession,
  requireSignedIn,
  TOKEN_PREFIX,
  tokenHash,
  workspaceFor,
} from "../http";

const { apiTokens } = schema;

const CreateToken = z.object({
  name: z.string().trim().min(1).max(80),
  /** Days until it stops working; none for a token that lasts until revoked. */
  expiresInDays: z.number().int().min(1).max(366).optional(),
});
const Params = z.object({ id: z.uuid() });

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** 40 base62 characters (~238 bits) after the prefix. */
function newToken(): string {
  const bytes = randomBytes(40);
  return TOKEN_PREFIX + [...bytes].map((b) => BASE62[b % 62]).join("");
}

const present = (t: typeof apiTokens.$inferSelect) => ({
  id: t.id,
  name: t.name,
  prefix: t.prefix,
  createdAt: t.createdAt,
  lastUsedAt: t.lastUsedAt,
  expiresAt: t.expiresAt,
  revokedAt: t.revokedAt,
});

export async function tokenRoutes(app: FastifyInstance, ctx: AppContext) {
  /** The caller's own tokens in the workspace (never the tokens themselves). */
  app.get("/v1/tokens", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s);
    const rows = await ctx.db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.workspaceId, workspaceId), eq(apiTokens.userId, s.userId)))
      .orderBy(desc(apiTokens.createdAt));
    return { tokens: rows.map(present) };
  });

  app.post("/v1/tokens", async (req, reply) => {
    const s = await requireSession(ctx, req);
    requireSignedIn(s, "make API tokens");
    const workspaceId = workspaceFor(req, s);
    // Viewers only read; a token acts as its person, so it needs a role that can act.
    await requireMember(ctx, workspaceId, s, ["owner", "admin", "member"]);
    const body = CreateToken.parse(req.body);
    const token = newToken();
    const row = one(
      await ctx.db
        .insert(apiTokens)
        .values({
          workspaceId,
          userId: s.userId,
          name: body.name,
          prefix: token.slice(0, TOKEN_PREFIX.length + 4),
          tokenHash: tokenHash(token),
          ...(body.expiresInDays
            ? { expiresAt: new Date(Date.now() + body.expiresInDays * 86_400_000) }
            : {}),
        })
        .returning(),
      "token",
    );
    await ctx.ledger.append(ctx.db, {
      workspaceId,
      kind: "key.added",
      payload: { apiTokenId: row.id, name: row.name, prefix: row.prefix, by: s.userId },
    });
    return reply.status(201).send({ token: { ...present(row), value: token } });
  });

  app.delete("/v1/tokens/:id", async (req, reply) => {
    const s = await requireSession(ctx, req);
    requireSignedIn(s, "revoke API tokens");
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s);
    const { id } = Params.parse(req.params);
    const [row] = await ctx.db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiTokens.id, id),
          eq(apiTokens.workspaceId, workspaceId),
          eq(apiTokens.userId, s.userId),
          isNull(apiTokens.revokedAt),
        ),
      )
      .returning();
    if (!row) throw new HttpError(404, "no such token", "not_found");
    await ctx.ledger.append(ctx.db, {
      workspaceId,
      kind: "key.removed",
      payload: { apiTokenId: row.id, name: row.name, prefix: row.prefix, by: s.userId },
    });
    return reply.status(204).send();
  });
}
