import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { sendFetchResponse } from "../http";

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
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (v === undefined) continue;
          for (const value of Array.isArray(v) ? v : [v]) headers.append(k, value);
        }
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
