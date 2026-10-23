// OAuth 2.1 discovery for remote MCP clients (docs/vendors/protocols.md §2): Protected Resource Metadata (RFC 9728) for
// /mcp, and the authorization server's metadata (RFC 8414 and OIDC discovery), at the origin's root where clients look
// for them (the web app proxies /.well-known and /mcp here). The flows themselves (authorize, token, register, consent)
// are Better Auth's, under /api/auth/oauth2/*.
import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../context";
import { sendFetchResponse } from "../http";

export async function oauthRoutes(app: FastifyInstance, ctx: AppContext) {
  const origin = ctx.config.APP_URL.replace(/\/+$/, "");
  const asRequest = (req: FastifyRequest) => new Request(`${origin}${req.url}`, { method: "GET" });
  const authServer = oauthProviderAuthServerMetadata(ctx.auth);
  const openId = oauthProviderOpenIdConfigMetadata(ctx.auth);

  // The MCP plugin answers its own resource metadata paths when a request reaches the auth handler.
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"])
    app.get(path, async (req, reply) => sendFetchResponse(reply, await ctx.auth.handler(asRequest(req))));

  // The issuer has the path /api/auth: clients try the path-inserted forms first, then the root ones.
  for (const path of [
    "/.well-known/oauth-authorization-server/api/auth",
    "/.well-known/oauth-authorization-server",
  ])
    app.get(path, async (req, reply) => sendFetchResponse(reply, await authServer(asRequest(req))));
  for (const path of ["/.well-known/openid-configuration/api/auth", "/.well-known/openid-configuration"])
    app.get(path, async (req, reply) => sendFetchResponse(reply, await openId(asRequest(req))));
}
