import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";

export async function healthRoutes(app: FastifyInstance, ctx: AppContext) {
  /** Liveness and database reachability: `{ ok, db }`. */
  app.get("/health", async (_req, reply) => {
    try {
      await ctx.db.execute(sql`select 1`);
      return { ok: true, db: "up" };
    } catch {
      return reply.status(503).send({ ok: false, db: "down" });
    }
  });

  /** Which sign-in methods this deployment offers, so the web app only shows working buttons. */
  app.get("/v1/auth/providers", async () => ({
    magicLink: true,
    passkey: true,
    google: ctx.config.google !== null,
  }));
}
