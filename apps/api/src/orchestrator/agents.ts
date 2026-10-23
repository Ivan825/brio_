// The workspace's agents as the router sees them: what each can do, where it runs, and whether it can run at all.
import type { CliSpec } from "@brio/adapters";
import type { RouteAgent } from "@brio/core";
import { schema } from "@brio/db";
import { registry } from "@brio/registry";
import { and, eq, isNull } from "drizzle-orm";
import { adapterOf, connectorConfig } from "../connectors";
import type { AppContext } from "../context";

export async function routeAgents(ctx: AppContext, workspaceId: string): Promise<RouteAgent[]> {
  const rows = await ctx.db
    .select({ agent: schema.agents, connector: schema.connectors })
    .from(schema.agents)
    .innerJoin(schema.connectors, eq(schema.connectors.id, schema.agents.connectorId))
    .where(
      and(
        eq(schema.agents.workspaceId, workspaceId),
        isNull(schema.agents.deletedAt),
        isNull(schema.connectors.deletedAt),
      ),
    );
  const out: RouteAgent[] = [];
  for (const { agent, connector } of rows) {
    let adapter: ReturnType<typeof adapterOf>;
    try {
      adapter = adapterOf(connector);
    } catch {
      continue;
    }
    const cc = connectorConfig(connector);
    const cli = (adapter as { spec?: CliSpec }).spec;
    const price = await ctx.pricing.lookup({
      presetKey: cc.presetKey,
      model: agent.model,
      override: agent.priceOverride ?? null,
    });
    const priced = price.kind !== "unknown" || cc.preset.reportsCost || cli?.reportsCost || cli?.unmetered;
    out.push({
      id: agent.id,
      name: agent.name,
      model: agent.model,
      route: adapter.route,
      vendor: cc.presetKey,
      taskTypes: registry().taskTypesOf(connector.registryKey),
      local: cc.preset.local,
      runnable: Boolean(priced) && connector.status !== "disabled",
    });
  }
  return out;
}
