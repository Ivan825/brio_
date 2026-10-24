import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { HttpError, sendFetchResponse } from "../http";

/**
 * Better Auth's own workspace endpoints that Brio replaces with routes of its own (security review M1): those apply
 * Brio's role rules (only owners make or remove admins; a workspace keeps an owner), soft-delete, revoke tokens and
 * write the ledger. Better Auth's versions would do none of that, so they are not reachable from outside.
 */
const FORWARDING = new Set([
  "x-forwarded-for",
  "x-real-ip",
  "forwarded",
  "cf-connecting-ip",
  "true-client-ip",
]);

const BRIO_OWNS = new Set([
  "/api/auth/organization/create",
  "/api/auth/organization/update",
  "/api/auth/organization/delete",
  "/api/auth/organization/invite-member",
  "/api/auth/organization/cancel-invitation",
  "/api/auth/organization/add-member",
  "/api/auth/organization/remove-member",
  "/api/auth/organization/update-member-role",
  "/api/auth/organization/leave",
]);

/** Mounts Better Auth's handler at /api/auth/*. */
export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  await app.register(async (sub) => {
    // OAuth token and revocation requests are form-encoded (RFC 6749 §4.1.3): pass them through as sent.
    sub.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) =>
      done(null, body),
    );
    sub.route({
      method: ["GET", "POST"],
      url: "/api/auth/*",
      async handler(req, reply) {
        const url = new URL(req.url, ctx.config.APP_URL);
        if (BRIO_OWNS.has(url.pathname))
          throw new HttpError(404, "use Brio's workspace routes (/v1/workspaces) for this", "not_found");
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (v === undefined || FORWARDING.has(k)) continue;
          for (const value of Array.isArray(v) ? v : [v]) headers.append(k, value);
        }
        // Rate limits key on the client's address: exactly the one Fastify trusted (BRIO_TRUST_PROXY_HOPS), never
        // a chain the client wrote itself (security review L1).
        headers.set("x-forwarded-for", req.ip);
        const body =
          req.method === "GET" || req.body === undefined
            ? undefined
            : typeof req.body === "string"
              ? req.body
              : JSON.stringify(req.body);
        const res = await ctx.auth.handler(new Request(url, { method: req.method, headers, body }));
        return sendFetchResponse(reply, res);
      },
    });
  });
}
