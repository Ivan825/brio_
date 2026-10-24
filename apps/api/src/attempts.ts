// Direct runs of one task by one chosen agent (D-29), until the scheduler (M3). The API resolves everything the run
// needs into a dispatch plan (attempts.dispatch), records it as an event and on the ledger, and queues it; a runner
// (apps/runner) claims it, sandboxes it when it touches files or is a CLI, and records the result.
import { type AgentConfig, type CliSpec, type Dispatch, EMPTY_BRIEF, type RunInput } from "@brio/adapters";
import {
  type AgentSandboxSetting,
  applyNetworkPolicy,
  browseHostsOf,
  chooseSandbox,
  routable,
} from "@brio/core";
import { schema } from "@brio/db";
import { brief } from "@brio/memory";
import { registry } from "@brio/registry";
import { enqueueAttempt, requestCancel } from "@brio/runner";
import { type Actor, type HandoffPacket, TaskContract, TaskType } from "@brio/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { checkBudgets, stopReason } from "./budgets";
import { adapterOf, connectorConfig, type Metering, meteringOf, toolsFor } from "./connectors";
import type { AppContext } from "./context";
import { HttpError, one } from "./http";
import { authorizeSpend } from "./mandate";
import { inputsForAttempt } from "./mission-inputs";
import { loadPolicies } from "./policies";
import { pokeRunner } from "./runners/hub";

const { agents, attempts, connectors, missions, projects, runners, tasks } = schema;

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
    files?: Array<{ path: string; content: string; encoding?: "base64" }>;
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
    const contract = TaskContract.parse(task.contract);
    // The project's repository may live on a person's machine (a local runner, M8): file work on it runs there.
    const [project] = mission.projectId
      ? await ctx.db.select().from(projects).where(eq(projects.id, mission.projectId))
      : [];
    // An agent bound to a local runner runs there, under the person's own sign-in: API keys never leave the vault.
    let target: Dispatch["target"];
    if (agent.runnerId) {
      const [r] = await ctx.db
        .select()
        .from(runners)
        .where(and(eq(runners.id, agent.runnerId), isNull(runners.revokedAt)));
      if (!r) throw new HttpError(409, `${agent.name}'s local runner was revoked`, "runner_revoked");
      if (connector.credentialRef)
        throw new HttpError(
          422,
          `${agent.name} is on a local runner, where API keys never go: install its connector for your own sign-in`,
          "key_on_local_runner",
        );
      if (project?.runnerId !== r.id)
        throw new HttpError(
          409,
          `${agent.name} runs on ${r.name}, which works only on the projects that live there`,
          "runner_cannot_reach",
        );
      target = { kind: "local", runnerId: r.id, mode: r.mode as "docker" | "host" };
    }
    const localLogin = Boolean((connector.config as { localLogin?: unknown }).localLogin);
    const taskType = TaskType.parse(task.type);
    const cc = connectorConfig(connector);
    // The workspace's policies (M9), checked again at dispatch whatever chose the agent: data routing by sensitivity
    // and the connector allow-list. Confidential work stays on local models unless a policy allows more.
    const policies = await loadPolicies(ctx.db, input.workspaceId);
    const allowed = routable(
      { registryKey: connector.registryKey, connectorId: connector.id, local: Boolean(cc.preset?.local) },
      contract.sensitivity,
      policies,
    );
    if (!allowed.ok) throw new HttpError(422, `policy: ${allowed.reason}`, "policy_denied");

    const cli = (adapter as { spec?: CliSpec }).spec;
    // Under the person's own sign-in the vendor bills their plan: nothing to meter here.
    const metering: Metering = localLogin
      ? { runnable: true, price: null, unitPrice: null, reason: null, estUsd: 0, priceKind: "subscription" }
      : await meteringOf(ctx, cc, adapter, {
          model: agent.model,
          priceOverride: agent.priceOverride ?? null,
          options: agent.options ?? {},
        });
    if (!metering.runnable)
      throw new HttpError(422, metering.reason ?? `no price is known for ${agent.model}`, "price_unknown");

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
      price: metering.price,
      unitPrice: metering.unitPrice,
      options: { ...agent.options, ...(localLogin ? { localLogin: true } : {}) },
    };
    // What the mission was started from (an issue, attached files), for every attempt.
    const given = await inputsForAttempt(ctx.db, input.workspaceId, mission.inputs);
    // The project's memory for this task (M9): the files it will touch and what it is about.
    const memo = project
      ? await brief(ctx.db, project.id, {
          paths: contract.expectedFootprint?.paths ?? [],
          topic: task.title,
        })
      : null;
    if (memo?.summary)
      given.files.push({ path: "brief.md", content: `# Project memory\n\n${memo.summary}\n` });
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
      brief: memo?.summary ? { summary: memo.summary, items: memo.items } : EMPTY_BRIEF,
      attachments: given.attachments,
      limits,
      mcpServers: [],
    };
    // The agent's MCP servers: named here, their credentials added by the runner; CLIs may reach their hosts.
    const mcp: NonNullable<Dispatch["mcp"]> = [];
    for (const t of (agent.tools ?? []) as Array<{ connectorId?: string }>) {
      if (!t.connectorId) continue;
      const [row] = await ctx.db
        .select()
        .from(schema.connectors)
        .where(
          and(eq(schema.connectors.id, t.connectorId), eq(schema.connectors.workspaceId, input.workspaceId)),
        );
      if (!row || row.deletedAt || row.status === "disabled") continue;
      const tcc = connectorConfig(row);
      if (tcc.service?.kind !== "mcp") continue;
      mcp.push({
        connectorId: row.id,
        name:
          row.displayName
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, "-")
            .slice(0, 40) || "mcp",
        url: tcc.baseUrl,
        credentialRef: row.credentialRef,
      });
    }
    const mcpHosts = mcp.flatMap((m) => {
      try {
        return [new URL(m.url).hostname];
      } catch {
        return [];
      }
    });
    // A computer-use agent on a cloud browser needs no local one (the cloud session holds the site allowlist itself).
    const cloudBrowser = adapter.route === "browser" && agent.options?.browser === "cloud";
    const chosen = cloudBrowser
      ? null
      : chooseSandbox({
          route: adapter.route,
          taskType: input.sandboxTaskType ?? taskType,
          agentSetting: agent.sandboxProfile as AgentSandboxSetting,
          vendorHosts: [...(cli?.egressHosts ?? []), ...(adapter.route === "cli" ? mcpHosts : [])],
          ...(adapter.route === "browser" ? { browseHosts: browseHostsOf(contract) } : {}),
          maxMinutes: limits.maxMinutes,
          // Reviewers and judges only read; makers of a contract that changes files get a worktree.
          writesFiles:
            !input.sandboxTaskType &&
            (Boolean(contract.expectedFootprint?.paths.length) ||
              // Generated media with a place in the repository (an output path) is part of the change too.
              contract.outputs.some((o) => o.kind === "diff" || o.kind === "file" || Boolean(o.path))),
        });
    // Network policies (M9): denied hosts are never reachable; allowed ones join code sandboxes' allowlists.
    const sandbox =
      chosen && chosen.network.mode === "allowlist"
        ? (() => {
            const hosts = applyNetworkPolicy(chosen.network.hosts, policies, {
              code: chosen.profile.startsWith("code"),
            });
            return {
              ...chosen,
              network: hosts.length ? { mode: "allowlist" as const, hosts } : { mode: "none" as const },
            };
          })()
        : chosen;
    const tools = await toolsFor(ctx, input.workspaceId, contract.sensitivity);
    if (cloudBrowser && !tools?.browser)
      throw new HttpError(
        422,
        `${agent.name} uses a cloud browser (options.browser = cloud), and the workspace has no healthy Browserbase or Steel connector`,
        "no_cloud_browser",
      );
    if (project?.runnerId && sandbox && !target)
      throw new HttpError(
        409,
        "this project lives on a local runner: work on its files runs on agents bound to that runner",
        "project_on_runner",
      );
    let repo: Dispatch["repo"] = null;
    let repoMap = input.repoMap;
    if (project) {
      if (project.repoUrl)
        repo = {
          url: project.repoUrl,
          branch: project.defaultBranch,
          ...(project.credentialRef ? { credentialRef: project.credentialRef } : {}),
        };
      // A repository on a local runner is mapped there: the planner gets its file list as an attachment.
      if (repo && repoMap && project.runnerId && !target) {
        repoMap = false;
        const listed = await ctx.runners.listFiles(project.runnerId, { url: repo.url, branch: repo.branch });
        runInput.attachments = [
          ...runInput.attachments,
          {
            kind: "repo-map",
            ref: `repository files (${listed?.files.length ?? 0})`,
            text: listed?.files.length
              ? listed.files.join("\n")
              : `(no file list: ${listed ? (listed.error ?? "the repository is empty") : "its local runner is offline"})`,
          },
        ];
      }
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
    // Budgets at every scope (M9): the estimate must fit what is left, and the attempt may spend no more than that.
    const budget = await checkBudgets(
      ctx.db,
      { workspaceId: input.workspaceId, agentId: agent.id, missionId: mission.id, taskId: task.id },
      estimate?.usd ?? 0,
    );
    if (!budget.ok) {
      const reason = stopReason(budget.scope);
      await ctx.events.append(ctx.db, {
        workspaceId: input.workspaceId,
        missionId: mission.id,
        taskId: task.id,
        type: "budget.stop",
        actor: "system",
        payload: {
          scope: budget.scope.kind,
          scopeId: budget.scope.id,
          limitUsd: budget.scope.limitUsd,
          spentUsd: budget.scope.spentUsd,
          estimateUsd: estimate?.usd ?? 0,
          reason,
        },
      });
      throw new HttpError(402, reason, "budget_exceeded");
    }
    if (budget.capUsd !== null) limits.maxCostUsd = Math.min(limits.maxCostUsd, budget.capUsd);
    // The workspace's mandate, when it connected one (D-07): authority for the attempt's cap, from the vendor that
    // bills it. A person's own plan (local sign-in) bills nothing here.
    const spend =
      metering.priceKind === "subscription"
        ? null
        : await authorizeSpend(ctx, {
            workspaceId: input.workspaceId,
            taskId: task.id,
            maxCostUsd: limits.maxCostUsd,
            merchant: registry().connector(connector.registryKey)?.maker ?? connector.registryKey,
            purpose: `Brio: ${task.title}`,
          });
    if (spend) limits.maxCostUsd = Math.min(limits.maxCostUsd, spend.capUsd);

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
      if (spend)
        await tx
          .update(schema.mandateHolds)
          .set({ attemptId: row.id })
          .where(eq(schema.mandateHolds.id, spend.holdId));
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
        image: adapter.route === "cli" ? "cli" : adapter.route === "browser" ? "browser" : "base",
        repo,
        ...(input.bases?.length ? { bases: input.bases } : {}),
        ...(input.files?.length || given.files.length
          ? { files: [...(input.files ?? []), ...given.files] }
          : {}),
        ...(tools ? { tools } : {}),
        ...(mcp.length ? { mcp } : {}),
        ...(repoMap ? { repoMap: true } : {}),
        ...(target ? { target } : {}),
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
          connector: {
            id: connector.id,
            registryKey: connector.registryKey,
            preset: cc.presetKey ?? null,
            service: cc.serviceKey ?? null,
          },
          adapter: adapter.key,
          route: adapter.route,
          price: {
            kind: metering.priceKind,
            ...(metering.price ?? {}),
            ...(metering.unitPrice
              ? { unit: metering.unitPrice.unit, usdPerUnit: metering.unitPrice.usd }
              : {}),
          },
          estimate,
          limits,
          sandbox: sandbox ? { profile: sandbox.profile, network: sandbox.network } : null,
          rationale: input.rationale ?? null,
          role: input.role ?? "maker",
          purpose: input.mode?.purpose ?? null,
          revision: input.feedback ? true : undefined,
          repo: repo ? { url: repo.url, branch: repo.branch } : null,
          tools: {
            search: tools?.search?.connector.serviceKey ?? null,
            fetch: tools?.fetch?.connector.serviceKey ?? null,
          },
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
    const runnerId = (attempt.dispatch as Dispatch | null)?.target?.runnerId;
    if (runnerId) {
      // A local runner takes it when it is connected (now, or when it next connects).
      await pokeRunner(ctx.db, runnerId).catch(() => {});
      return attempt;
    }
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
