// Direct runs of one task by one chosen agent (D-29), until the scheduler (M3). The API resolves everything the run
// needs into a dispatch plan (attempts.dispatch), records it as an event and on the ledger, and queues it; a runner
// (apps/runner) claims it, sandboxes it when it touches files or is a CLI, and records the result.
import { type AgentConfig, type CliSpec, type Dispatch, EMPTY_BRIEF, type RunInput } from "@brio/adapters";
import { type AgentSandboxSetting, chooseSandbox } from "@brio/core";
import { schema } from "@brio/db";
import { enqueueAttempt, requestCancel } from "@brio/runner";
import { type Actor, type HandoffPacket, TaskContract, TaskType } from "@brio/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { adapterOf, connectorConfig } from "./connectors";
import type { AppContext } from "./context";
import { HttpError, one } from "./http";

const { agents, attempts, connectors, missions, projects, tasks } = schema;

/** Per-attempt defaults when neither the agent nor the task sets a limit. */
export const DEFAULT_LIMITS = { maxCostUsd: 1, maxMinutes: 10, maxOutputTokens: 8192, maxTurns: 12 } as const;

export const RUNNABLE_TASK = ["pending", "ready", "failed", "verifying", "revise", "blocked"] as const;

type AttemptRow = typeof attempts.$inferSelect;

export function renderInstructions(
  task: { title: string; type: string },
  contract: TaskContract,
  goal: string,
) {
  const lines = [
    `# Task: ${task.title}`,
    `Type: ${task.type}`,
    "",
    "## Mission goal",
    goal,
    "",
    "## Objective",
    contract.objective,
  ];
  if (contract.inputs.length)
    lines.push("", "## Inputs", ...contract.inputs.map((i) => `- ${i.kind}: ${i.ref}`));
  lines.push("", "## Expected outputs", ...contract.outputs.map((o) => `- ${o.kind}: ${o.description}`));
  lines.push(
    "",
    "## Acceptance checks",
    ...contract.acceptance.map(
      (a) => `- ${a.kind}${a.hard === false ? " (soft)" : ""}${a.command ? `: ${a.command}` : ""}`,
    ),
  );
  if (contract.constraints.length)
    lines.push("", "## Constraints", ...contract.constraints.map((c) => `- ${c}`));
  return lines.join("\n");
}

export class AttemptRunner {
  constructor(private readonly ctx: AppContext) {}

  /** Validates, resolves and records the dispatch, then queues it. Returns the queued attempt. */
  async start(input: {
    workspaceId: string;
    taskId: string;
    agentId: string;
    /** Who dispatched: a user (direct run) or the system (the scheduler). */
    actor: Actor;
    /** Replaces the instructions rendered from the contract (the planner's prompt). */
    instructions?: string;
    /** Appended to the instructions: why the previous attempt was sent back. */
    feedback?: string;
    handoffs?: HandoffPacket[];
    bases?: string[];
    files?: Array<{ path: string; content: string }>;
    repoMap?: boolean;
    /** The router's one-line reason, shown on the board. */
    rationale?: string;
    /** Multi-agent modes: the attempt's role, and what it is for. The task is already running and stays the orchestrator's. */
    role?: "maker" | "candidate" | "checker" | "judge" | "merger";
    mode?: Dispatch["mode"];
    /** Reviewers and judges read results; they need no sandbox of the task's kind. */
    sandboxTaskType?: string;
    /** A merge task: conflicting bases are merged with their conflict markers left in. */
    keepConflicts?: boolean;
  }): Promise<AttemptRow> {
    const { ctx } = this;
    const { actor } = input;
    const [task] = await ctx.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, input.taskId), eq(tasks.workspaceId, input.workspaceId)));
    if (!task) throw new HttpError(404, "task not found", "not_found");
    const [mission] = await ctx.db.select().from(missions).where(eq(missions.id, task.missionId));
    if (!mission) throw new HttpError(404, "mission not found", "not_found");
    if (mission.status === "cancelled" || mission.status === "done")
      throw new HttpError(409, `the mission is ${mission.status}`, "mission_closed");
    const concurrent = Boolean(input.mode);
    // Mode attempts join a running task; a verifier's agent checks join a task being verified.
    const joinable =
      task.status === "running" || (task.status === "verifying" && input.mode?.purpose === "check");
    if (concurrent ? !joinable : !(RUNNABLE_TASK as readonly string[]).includes(task.status))
      throw new HttpError(409, `the task is ${task.status}`, "task_busy");

    const [agent] = await ctx.db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.id, input.agentId),
          eq(agents.workspaceId, input.workspaceId),
          isNull(agents.deletedAt),
        ),
      );
    if (!agent) throw new HttpError(404, "agent not found", "not_found");
    const [connector] = await ctx.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.id, agent.connectorId), isNull(connectors.deletedAt)));
    if (!connector) throw new HttpError(409, "the agent's connector was removed", "connector_removed");
    if (connector.status === "disabled")
      throw new HttpError(409, "the connector is disabled", "connector_disabled");

    const adapter = adapterOf(connector);
    if (adapter.route !== "api" && adapter.route !== "cli")
      throw new HttpError(422, `${adapter.route} agents arrive in a later milestone`, "route_unavailable");
    const contract = TaskContract.parse(task.contract);
    const taskType = TaskType.parse(task.type);
    const cc = connectorConfig(connector);
    // Fail closed until the policy engine (M9): confidential work stays on the user's own machine.
    if (contract.sensitivity === "confidential" && !cc.preset.local)
      throw new HttpError(
        422,
        "confidential tasks can only run on local models until data-routing policies arrive",
        "policy_denied",
      );

    const cli = (adapter as { spec?: CliSpec }).spec;
    const resolved = await ctx.pricing.lookup({
      presetKey: cc.presetKey,
      model: agent.model,
      override: agent.priceOverride ?? null,
    });
    if (resolved.kind === "unknown" && !cc.preset.reportsCost && !cli?.reportsCost && !cli?.unmetered)
      throw new HttpError(422, `no price is known for ${agent.model}; set one on the agent`, "price_unknown");

    const agentLimits = agent.limits as { maxCostUsd?: number; maxMinutes?: number; maxTokens?: number };
    const caps = [agentLimits.maxCostUsd, task.budget.usd, contract.budget?.usd].filter(
      (v): v is number => typeof v === "number",
    );
    const limits = {
      maxCostUsd: caps.length ? Math.min(...caps) : DEFAULT_LIMITS.maxCostUsd,
      maxMinutes: Math.min(
        agentLimits.maxMinutes ?? DEFAULT_LIMITS.maxMinutes,
        task.budget.minutes ?? Number.POSITIVE_INFINITY,
        contract.budget?.minutes ?? Number.POSITIVE_INFINITY,
      ),
      maxOutputTokens: agentLimits.maxTokens ?? DEFAULT_LIMITS.maxOutputTokens,
      maxTurns: DEFAULT_LIMITS.maxTurns,
    };

    const agentConfig: AgentConfig = {
      agentId: agent.id,
      name: agent.name,
      model: agent.model,
      rolePrompt: agent.rolePrompt,
      connector: cc,
      price: resolved.kind === "unknown" ? null : resolved.price,
      options: agent.options,
    };
    const runInput: Omit<RunInput, "attemptId"> = {
      taskTitle: task.title,
      taskType,
      instructions: [
        input.instructions ?? renderInstructions(task, contract, mission.goal),
        input.feedback
          ? `## Your previous attempt was sent back\n${input.feedback}\nFix this and finish the task.`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      contract,
      handoffs: input.handoffs ?? [],
      brief: EMPTY_BRIEF,
      attachments: [],
      limits,
      mcpServers: [],
    };
    const sandbox = chooseSandbox({
      route: adapter.route,
      taskType: input.sandboxTaskType ?? taskType,
      agentSetting: agent.sandboxProfile as AgentSandboxSetting,
      vendorHosts: cli?.egressHosts ?? [],
      maxMinutes: limits.maxMinutes,
      // Reviewers and judges only read; makers of a contract that changes files get a worktree.
      writesFiles:
        !input.sandboxTaskType &&
        (Boolean(contract.expectedFootprint?.paths.length) ||
          contract.outputs.some((o) => o.kind === "diff" || o.kind === "file")),
    });
    let repo: Dispatch["repo"] = null;
    if (mission.projectId) {
      const [project] = await ctx.db.select().from(projects).where(eq(projects.id, mission.projectId));
      if (project?.repoUrl) repo = { url: project.repoUrl, branch: project.defaultBranch };
    }
    const estimate = await adapter
      .estimate({ ...runInput, attemptId: "estimate" }, agentConfig)
      .catch(() => null);
    if (estimate && estimate.usd > limits.maxCostUsd * 10)
      throw new HttpError(
        422,
        `estimated $${estimate.usd} is far over the $${limits.maxCostUsd} limit`,
        "over_budget",
      );

    const attempt = await ctx.db.transaction(async (tx) => {
      // Lock the task so two clicks cannot start two attempts (multi-agent modes add attempts to a running task).
      if (!concurrent) {
        const [locked] = await tx
          .update(tasks)
          .set({ status: "running", pinnedAgentId: agent.id })
          .where(and(eq(tasks.id, task.id), inArray(tasks.status, [...RUNNABLE_TASK])))
          .returning();
        if (!locked) throw new HttpError(409, "the task is already running", "task_busy");
      }
      const row = one(
        await tx
          .insert(attempts)
          .values({
            workspaceId: input.workspaceId,
            taskId: task.id,
            agentId: agent.id,
            role: input.role ?? "maker",
            status: "queued",
          })
          .returning(),
        "attempt",
      );
      const dispatch: Dispatch = {
        version: 1,
        adapterKey: adapter.key,
        route: adapter.route,
        missionId: mission.id,
        taskId: task.id,
        taskKey: task.key,
        connectorId: connector.id,
        credentialRef: connector.credentialRef,
        input: runInput,
        agent: agentConfig,
        sandbox,
        image: adapter.route === "cli" ? "cli" : "base",
        repo,
        ...(input.bases?.length ? { bases: input.bases } : {}),
        ...(input.files?.length ? { files: input.files } : {}),
        ...(input.repoMap ? { repoMap: true } : {}),
        ...(input.keepConflicts ? { keepConflicts: true } : {}),
        ...(concurrent ? { manageTask: false, mode: input.mode } : {}),
      };
      await tx
        .update(attempts)
        .set({ dispatch: dispatch as unknown as Record<string, unknown> })
        .where(eq(attempts.id, row.id));
      await ctx.events.append(tx, {
        workspaceId: input.workspaceId,
        missionId: mission.id,
        taskId: task.id,
        attemptId: row.id,
        type: "attempt.queued",
        actor,
        payload: {
          taskKey: task.key,
          agent: { id: agent.id, name: agent.name, model: agent.model },
          connector: { id: connector.id, registryKey: connector.registryKey, preset: cc.presetKey },
          adapter: adapter.key,
          route: adapter.route,
          price:
            resolved.kind === "unknown"
              ? { kind: "vendor_reported" }
              : { kind: resolved.kind, ...resolved.price },
          estimate,
          limits,
          sandbox: sandbox ? { profile: sandbox.profile, network: sandbox.network } : null,
          rationale: input.rationale ?? null,
          role: input.role ?? "maker",
          purpose: input.mode?.purpose ?? null,
          revision: input.feedback ? true : undefined,
          repo: repo ? { url: repo.url, branch: repo.branch } : null,
        },
      });
      await ctx.ledger.append(tx, {
        workspaceId: input.workspaceId,
        kind: "dispatch",
        payload: {
          attemptId: row.id,
          missionId: mission.id,
          taskId: task.id,
          agentId: agent.id,
          model: agent.model,
          connector: connector.registryKey,
          adapter: adapter.key,
          estimateUsd: estimate?.usd ?? null,
          limitUsd: limits.maxCostUsd,
          by: actor,
        },
      });
      return row;
    });
    // After commit; the runners' reaper re-queues anything whose job is lost.
    await enqueueAttempt(ctx.queue, attempt.id).catch((err) =>
      ctx.log.warn(
        { err: (err as Error).message, attemptId: attempt.id },
        "enqueue failed; the reaper will retry",
      ),
    );
    return attempt;
  }

  /**
   * Cancels an attempt. A queued one is cancelled here; a running one is signalled to its runner, which stops the
   * sandbox and records the result. Resolves once the attempt is no longer running (or after `waitMs`).
   */
  async cancel(attemptId: string, workspaceId: string, userId: string, waitMs = 15_000): Promise<boolean> {
    const actor: Actor = userId === "system" ? "system" : `user:${userId}`;
    const { ctx } = this;
    const [row] = await ctx.db
      .select({ attempt: attempts, missionId: tasks.missionId })
      .from(attempts)
      .innerJoin(tasks, eq(tasks.id, attempts.taskId))
      .where(and(eq(attempts.id, attemptId), eq(attempts.workspaceId, workspaceId)));
    if (!row) throw new HttpError(404, "attempt not found", "not_found");
    const { attempt, missionId } = row;
    if (attempt.status === "queued") {
      const done = await ctx.db.transaction(async (tx) => {
        const [c] = await tx
          .update(attempts)
          .set({ status: "cancelled", endedAt: new Date(), exitReason: "cancelled before it started" })
          .where(and(eq(attempts.id, attemptId), eq(attempts.status, "queued")))
          .returning({ id: attempts.id });
        if (!c) return false;
        // A concurrent attempt (a mode's or a verifier's) leaves the task to the orchestrator.
        if ((attempt.dispatch as Dispatch | null)?.manageTask !== false)
          await tx
            .update(tasks)
            .set({ status: "ready" })
            .where(and(eq(tasks.id, attempt.taskId), eq(tasks.status, "running")));
        await ctx.events.append(tx, {
          workspaceId,
          missionId,
          taskId: attempt.taskId,
          attemptId,
          type: "attempt.finished",
          actor,
          payload: { status: "cancelled", exitReason: "cancelled before it started" },
        });
        return true;
      });
      if (done) return true;
    }
    if (attempt.status !== "running" && attempt.status !== "queued") return false;
    await requestCancel(ctx.db, attemptId);
    await this.settled(attemptId, waitMs);
    return true;
  }

  /** Waits until the attempt has left queued/running (tests, the cancel endpoint). */
  async settled(attemptId: string, timeoutMs = 120_000): Promise<AttemptRow | null> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const [a] = await this.ctx.db.select().from(attempts).where(eq(attempts.id, attemptId));
      if (!a || (a.status !== "queued" && a.status !== "running") || Date.now() > until) return a ?? null;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
