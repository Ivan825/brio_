// The workspace's agents as the router sees them: what each can do, where it runs, and whether it can run at all.
import type { CliSpec } from "@brio/adapters";
import { estimateCost, type RouteAgent } from "@brio/core";
import { schema } from "@brio/db";
import { registry } from "@brio/registry";
import { and, eq, isNull } from "drizzle-orm";
import { adapterOf, connectorConfig } from "../connectors";
import type { AppContext } from "../context";

export interface WorkspaceAgent extends RouteAgent {
  /** The scoreboard key: CLIs by adapter, model APIs by preset ("claude-code/…", "anthropic/…"). */
  scoreKey: string;
  /** False when the connector's last health check failed. */
  healthy: boolean;
  /** A rough cost per attempt before the scoreboard knows better. */
  estUsd: number;
}

export async function routeAgents(ctx: AppContext, workspaceId: string): Promise<WorkspaceAgent[]> {
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
  const out: WorkspaceAgent[] = [];
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
    const limits = agent.limits as { maxTokens?: number };
    const estUsd =
      price.kind === "unknown"
        ? 0
        : estimateCost(
            { promptChars: 12_000, maxOutputTokens: Math.min(limits.maxTokens ?? 4000, 4000), turns: 3 },
            price.price,
          );
    const health = connector.health as { ok?: boolean };
    out.push({
      scoreKey: `${adapter.route === "cli" ? adapter.key : cc.presetKey}/${agent.model}`,
      healthy: health.ok !== false,
      estUsd,
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
