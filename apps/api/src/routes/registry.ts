import { IMPLEMENTED_FAMILIES } from "@brio/adapters";
import { registry } from "@brio/registry";
import type { FastifyInstance } from "fastify";
import { cliFor, installablePresets } from "../connectors";
import type { AppContext } from "../context";
import { requireSession } from "../http";

/** What a service's credential is, for the install form. */
const CREDENTIAL: Record<string, { kind: "key" | "json"; hint: string; optional?: boolean }> = {
  bearer: { kind: "key", hint: "API key" },
  "optional-bearer": {
    kind: "key",
    hint: "Bearer token (leave empty if the agent needs none)",
    optional: true,
  },
  header: { kind: "key", hint: "API key" },
  "aws-sigv4": {
    kind: "json",
    hint: '{"accessKeyId":"…","secretAccessKey":"…","sessionToken":"…"} (session token optional)',
  },
  entra: { kind: "json", hint: '{"tenantId":"…","clientId":"…","clientSecret":"…"} (a service principal)' },
};

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
            plannedAdapter: c.plannedAdapter,
            implemented: r.isImplemented(c.id, IMPLEMENTED_FAMILIES),
            regionLimited: c.regionLimited ?? null,
            alternatives: (c.alternatives ?? []).map((id) => ({ id, name: r.connector(id)?.name ?? id })),
            taskTypes: r.taskTypesOf(c.id),
            cli: cliFor(c)?.adapter.key ?? null,
            // A local runner may run this CLI under the person's own sign-in (the vendor's terms, M8).
            localLogin: cliFor(c) ? (c.localLogin ?? null) : null,
            services: r.servicesFor(c.id).map(({ key, service: sv }) => ({
              key,
              name: sv.name,
              kind: sv.kind,
              credential: CREDENTIAL[sv.auth.scheme],
              settings: sv.settings,
              pricing: sv.pricing,
              keyCheck: sv.health !== null,
              docsUrl: sv.docsUrl,
              verifiedOn: sv.verifiedOn,
              notes: sv.notes ?? null,
            })),
            presets: installablePresets(c).map(({ key, preset: p }) => ({
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
