import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { sendFetchResponse } from "../http";

/** Mounts Better Auth's handler at /api/auth/*. */
export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(req, reply) {
      const url = new URL(req.url, ctx.config.APP_URL);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        for (const value of Array.isArray(v) ? v : [v]) headers.append(k, value);
      }
      const body = req.method === "GET" || req.body === undefined ? undefined : JSON.stringify(req.body);
      const res = await ctx.auth.handler(new Request(url, { method: req.method, headers, body }));
      return sendFetchResponse(reply, res);
    },
  });
}
