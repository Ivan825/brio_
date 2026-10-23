import { IMPLEMENTED_FAMILIES } from "@brio/adapters";
import { registry } from "@brio/registry";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { requireSession } from "../http";

/** The connector catalogue: every registry entry grouped by category, with what Brio can actually reach today. */
export async function registryRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/v1/registry", async (req) => {
    await requireSession(ctx, req);
    const r = registry();
    return {
      generatedOn: r.generatedOn,
      categories: r.categories.map((cat) => ({
        id: cat.id,
        name: cat.name,
        description: cat.description,
        connectors: r.connectors
          .filter((c) => c.category === cat.id)
          .map((c) => ({
            id: c.id,
            name: c.name,
            maker: c.maker,
            routes: c.routes,
            howToConnect: c.howToConnect,
            status: c.status,
            statusKey: c.statusKey,
            tier: c.tier,
            notes: c.notes,
            supported: c.supported,
            buildMilestone: c.buildMilestone,
            implemented: r.isImplemented(c.id, IMPLEMENTED_FAMILIES),
            regionLimited: c.regionLimited ?? null,
            taskTypes: r.taskTypesOf(c.id),
            presets: r.presetsFor(c.id).map(({ key, preset: p }) => ({
              key,
              name: p.name,
              family: p.family,
              auth: p.auth,
              baseUrl: p.baseUrl,
              baseUrlEditable: p.baseUrlEditable,
              regions: p.regions,
              apiStyles: p.apiStyles,
              local: p.local,
              regionLimited: p.regionLimited ?? null,
              docsUrl: p.docsUrl,
              verifiedOn: p.verifiedOn,
              notes: p.notes ?? null,
            })),
          })),
      })),
    };
  });
}
