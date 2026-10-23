import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { HttpError, requireMember, requireSession, workspaceFor } from "../http";

const Query = z.object({ preset: z.string().min(1).optional() });

export async function pricingRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/v1/pricing", async (req) => {
    await requireSession(ctx, req);
    const { preset } = Query.parse(req.query);
    const rows = await ctx.pricing.list(preset);
    return {
      prices: rows.map((r) => ({
        preset: r.presetKey,
        model: r.model,
        ...r.price,
        source: r.source,
        sourceUrl: r.sourceUrl,
        fetchedAt: r.fetchedAt,
      })),
    };
  });

  /** Pulls live prices now. Prices are public data; any workspace admin may refresh them. */
  app.post("/v1/pricing/refresh", async (req) => {
    const s = await requireSession(ctx, req);
    await requireMember(ctx, workspaceFor(req, s), s.userId, ["owner", "admin"]);
    try {
      const updated = await ctx.pricing.refreshFromOpenRouter(AbortSignal.timeout(30_000));
      return { updated };
    } catch (e) {
      throw new HttpError(502, `price refresh failed: ${(e as Error).message}`, "vendor_error");
    }
  });
}
