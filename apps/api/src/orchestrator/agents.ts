// The workspace's agents as the router sees them: what each can do, where it runs, and whether it can run at all.
import { estimateCost, type RouteAgent } from "@brio/core";
import { schema } from "@brio/db";
import { registry } from "@brio/registry";
import { and, eq, isNull } from "drizzle-orm";
import { adapterOf, connectorConfig, meteringOf, vendorOf } from "../connectors";
import type { AppContext } from "../context";

export interface WorkspaceAgent extends RouteAgent {
  /** The scoreboard key: CLIs by adapter, model APIs by preset ("claude-code/…", "anthropic/…"). */
  scoreKey: string;
  /** False when the connector's last health check failed. */
  healthy: boolean;
  /** A rough cost per attempt before the scoreboard knows better. */
  estUsd: number;
  /** The local runner it runs on (M8); null for the cloud. */
  runnerId: string | null;
  /** For the policy engine (M9): its registry connector and installed connector. */
  registryKey: string;
  connectorId: string;
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
    // A CLI under the person's own sign-in (a local runner) is billed to their plan: runnable, nothing to estimate.
    const localLogin = Boolean((connector.config as { localLogin?: unknown }).localLogin);
    const metering = await meteringOf(ctx, cc, adapter, {
      model: agent.model,
      priceOverride: agent.priceOverride ?? null,
      options: (agent.options ?? {}) as Record<string, unknown>,
    });
    const limits = agent.limits as { maxTokens?: number };
    const estUsd = metering.price
      ? estimateCost(
          { promptChars: 12_000, maxOutputTokens: Math.min(limits.maxTokens ?? 4000, 4000), turns: 3 },
          metering.price,
        )
      : localLogin
        ? 0
        : metering.estUsd;
    const health = connector.health as { ok?: boolean };
    out.push({
      scoreKey: `${adapter.route === "api" && cc.presetKey ? cc.presetKey : adapter.key}/${agent.model}`,
      healthy: health.ok !== false,
      estUsd,
      id: agent.id,
      name: agent.name,
      model: agent.model,
      route: adapter.route,
      vendor: vendorOf(cc),
      taskTypes:
        (connector.config as { taskTypes?: string[] }).taskTypes ??
        registry()
          .taskTypesOf(connector.registryKey)
          .filter((t) => !cc.service?.taskTypes || cc.service.taskTypes.includes(t)),
      local: cc.preset?.local ?? false,
      runnable: (metering.runnable || localLogin) && connector.status !== "disabled",
      runnerId: agent.runnerId ?? null,
      registryKey: connector.registryKey,
      connectorId: connector.id,
    });
  }
  return out;
}

/**
 * The agents a mission may use: the workspace's, or only its crew's (a deleted crew leaves none, so the mission says it
 * is blocked rather than quietly using everyone). Agents on a local runner (M8) work only on the projects that live
 * on it.
 */
export async function missionAgents(
  ctx: AppContext,
  m: Pick<typeof schema.missions.$inferSelect, "workspaceId" | "routing" | "projectId">,
): Promise<WorkspaceAgent[]> {
  const runnerId = await projectRunnerOf(ctx, m.projectId);
  const all = (await routeAgents(ctx, m.workspaceId)).filter((a) => !a.runnerId || a.runnerId === runnerId);
  if (m.routing.strategy !== "crew") return all;
  const crew = await crewOf(ctx, m.workspaceId, m.routing.crewId);
  return crew ? all.filter((a) => crew.agentIds.includes(a.id)) : [];
}

/** The crew's preferred agent for a task type, if it has one. */
export async function crewPin(
  ctx: AppContext,
  m: Pick<typeof schema.missions.$inferSelect, "workspaceId" | "routing">,
  taskType: string,
): Promise<string | null> {
  if (m.routing.strategy !== "crew") return null;
  const crew = await crewOf(ctx, m.workspaceId, m.routing.crewId);
  return crew?.routingPrefs.pins?.[taskType] ?? null;
}

async function crewOf(ctx: AppContext, workspaceId: string, id: string) {
  const [crew] = await ctx.db
    .select()
    .from(schema.crews)
    .where(
      and(eq(schema.crews.id, id), eq(schema.crews.workspaceId, workspaceId), isNull(schema.crews.deletedAt)),
    );
  return crew ?? null;
}

/** The local runner a project lives on, if any. */
export async function projectRunnerOf(ctx: AppContext, projectId: string | null): Promise<string | null> {
  if (!projectId) return null;
  const [p] = await ctx.db
    .select({ runnerId: schema.projects.runnerId })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));
  return p?.runnerId ?? null;
}

/**
 * Whether a task works on the repository's files: code and design, and also a voiceover reading the script a writer
 * produced, or an image placed next to the page that uses it.
 */
export function worksOnFiles(
  t: { type: string },
  contract: {
    expectedFootprint?: { paths: string[] } | undefined;
    outputs: Array<{ kind: string; path?: string | undefined }>;
    inputs: Array<{ kind: string }>;
  },
): boolean {
  return (
    t.type.startsWith("code.") ||
    t.type === "merge.integrate" ||
    t.type.startsWith("design.") ||
    Boolean(contract.expectedFootprint?.paths.length) ||
    contract.outputs.some((o) => o.kind === "diff" || o.kind === "file" || Boolean(o.path)) ||
    contract.inputs.some((i) => i.kind === "file")
  );
}
