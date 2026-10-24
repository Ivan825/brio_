import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";

/** Local-only: read the emails LogMailer "sent". Registered only when BRIO_DEV_OUTBOX=true (never in production). */
export async function devRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/v1/dev/outbox", async (req) => {
    const { email } = z.object({ email: z.email() }).parse(req.query);
    return { messages: ctx.outbox.messagesFor(email) };
  });
}
