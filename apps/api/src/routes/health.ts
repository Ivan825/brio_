import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";

export async function healthRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/health", async (_req, reply) => {
    try {
      await ctx.db.execute(sql`select 1`);
      return { ok: true, db: "up" };
    } catch {
      return reply.status(503).send({ ok: false, db: "down" });
    }
  });
}
