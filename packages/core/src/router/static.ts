// The temporary static router (BUILD_PLAN M3) until the scoreboard router (M4): a user pin wins; otherwise the first
// capable agent by a fixed preference. It adapts to however many agents are connected (D-43): none → the task waits
// with a reason, one → everything goes to it, several → the preferred one per task type. Modes that need several agents
// degrade to single and say so.

export type AgentRoute = "api" | "cli" | "sdk" | "hosted" | "a2a" | "mcp" | "browser" | "local";

export interface RouteAgent {
  id: string;
  name: string;
  model: string;
  route: AgentRoute;
  /** The vendor behind the agent (preset key), so reviewers can differ from makers. */
  vendor: string;
  taskTypes: readonly string[];
  /** Runs on the user's machine (local models): the only place confidential work may go until M9 policies. */
  local: boolean;
  /** Has a price (or is free, or reports cost) and an active connector. */
  runnable: boolean;
}

export interface RouteTask {
  key: string;
  type: string;
  sensitivity: "public" | "internal" | "confidential";
  pinnedAgentId: string | null;
  mode: string;
  /**
   * The candidates were already filtered by the workspace's policies (M9, policy/routable), which own data routing:
   * the router's own fallback (confidential stays local) then steps aside.
   */
  policyChecked?: boolean;
}

export type RouteDecision =
  | { ok: true; mode: "single"; agentId: string; rationale: string; degraded?: string }
  | { ok: false; reason: string };

const MULTI_AGENT_MODES: Record<string, number> = {
  best_of_n: 2,
  ensemble: 2,
  maker_checker: 2,
  debate: 2,
  cascade: 2,
  pipeline: 1,
};

/** Why this agent is a sensible first choice for this kind of task, before M4 has scores. */
function preference(task: RouteTask, a: RouteAgent): number {
  const code = task.type.startsWith("code.") || task.type === "merge.integrate";
  if (code) return a.route === "cli" ? 0 : a.route === "api" ? 1 : 2;
  return a.route === "api" ? 0 : a.route === "cli" ? 1 : 2;
}

export function eligibleAgents(task: RouteTask, agents: readonly RouteAgent[]): RouteAgent[] {
  return agents.filter(
    (a) =>
      a.runnable &&
      a.taskTypes.includes(task.type) &&
      (task.policyChecked || task.sensitivity !== "confidential" || a.local),
  );
}

export function staticRoute(task: RouteTask, agents: readonly RouteAgent[]): RouteDecision {
  const needed = MULTI_AGENT_MODES[task.mode] ?? 1;
  const degraded =
    task.mode !== "single"
      ? `${task.mode.replace("_", " ")} arrives with the router in M4${needed > 1 ? ` and needs ${needed}+ agents` : ""}; running single`
      : undefined;

  if (task.pinnedAgentId) {
    const pinned = agents.find((a) => a.id === task.pinnedAgentId);
    if (!pinned) return { ok: false, reason: "the pinned agent no longer exists" };
    if (!pinned.runnable)
      return { ok: false, reason: `${pinned.name} cannot run (no price or connector off)` };
    if (!task.policyChecked && task.sensitivity === "confidential" && !pinned.local)
      return { ok: false, reason: `${pinned.name} is not local; confidential tasks stay on local models` };
    return {
      ok: true,
      mode: "single",
      agentId: pinned.id,
      rationale: `${pinned.name} (pinned)`,
      ...(degraded ? { degraded } : {}),
    };
  }

  if (agents.length === 0) return { ok: false, reason: "no agents yet: add a connector and build an agent" };
  const eligible = eligibleAgents(task, agents);
  if (eligible.length === 0) {
    if (!task.policyChecked && task.sensitivity === "confidential")
      return { ok: false, reason: "confidential: needs a local model agent" };
    return { ok: false, reason: `none of your ${agents.length} agent(s) can do ${task.type}` };
  }
  const [best] = [...eligible].sort(
    (a, b) => preference(task, a) - preference(task, b) || a.name.localeCompare(b.name),
  );
  const chosen = best as RouteAgent;
  const why =
    eligible.length === 1
      ? `${chosen.name}: the only agent that can do ${task.type}`
      : `${chosen.name}: ${chosen.route === "cli" ? "a coding CLI" : "a model API"} preferred for ${task.type} (static routing until the scoreboard, M4)`;
  return { ok: true, mode: "single", agentId: chosen.id, rationale: why, ...(degraded ? { degraded } : {}) };
}

/** The agent to plan a mission: the first runnable model-API agent that can do plan.decompose. */
export function choosePlanner(agents: readonly RouteAgent[], pinned: string | null): RouteDecision {
  return staticRoute(
    { key: "plan", type: "plan.decompose", sensitivity: "internal", pinnedAgentId: pinned, mode: "single" },
    agents.filter((a) => a.route === "api" || a.id === pinned),
  );
}
