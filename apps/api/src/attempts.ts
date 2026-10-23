// Direct runs of one task by one pinned agent (D-29). Until the scheduler and runner arrive (M2/M3), model-API attempts
// run here, in-process, with no sandbox: they answer in text and get no file or shell tools. Every step is an event,
// every dispatch and spend is on the ledger, and the answer is stored as a content-addressed artifact.
import { createHash } from "node:crypto";
import {
  type AdapterEvent,
  type AgentConfig,
  EMPTY_BRIEF,
  LimitExceeded,
  NO_SANDBOX,
  pinoSink,
  type RunInput,
  type RunResult,
  redactingLogger,
} from "@brio/adapters";
import { type DbOrTx, schema } from "@brio/db";
import { type Actor, type EventType, TaskContract, TaskType } from "@brio/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { adapterOf, connectorConfig, credentialOf } from "./connectors";
import type { AppContext } from "./context";
import { HttpError, one } from "./http";

const { agents, attempts, artifacts, blobs, connectors, missions, tasks } = schema;

/** Per-attempt defaults when neither the agent nor the task sets a limit. */
export const DEFAULT_LIMITS = { maxCostUsd: 1, maxMinutes: 10, maxOutputTokens: 8192, maxTurns: 12 } as const;

const RUNNABLE_TASK = ["pending", "ready", "failed", "verifying", "revise", "blocked"] as const;

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
  private readonly running = new Map<string, { abort: AbortController; done: Promise<void> }>();

  constructor(private readonly ctx: AppContext) {}

  get activeCount(): number {
    return this.running.size;
  }

  /** Validates, records the dispatch and starts the run in the background. Returns the attempt row immediately. */
  async start(input: {
    workspaceId: string;
    taskId: string;
    agentId: string;
    userId: string;
  }): Promise<AttemptRow> {
    const { ctx } = this;
    const actor: Actor = `user:${input.userId}`;
    const [task] = await ctx.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, input.taskId), eq(tasks.workspaceId, input.workspaceId)));
    if (!task) throw new HttpError(404, "task not found", "not_found");
    const [mission] = await ctx.db.select().from(missions).where(eq(missions.id, task.missionId));
    if (!mission) throw new HttpError(404, "mission not found", "not_found");
    if (mission.status === "cancelled" || mission.status === "done")
      throw new HttpError(409, `the mission is ${mission.status}`, "mission_closed");
    if (!(RUNNABLE_TASK as readonly string[]).includes(task.status))
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
    if (adapter.route !== "api")
      throw new HttpError(
        422,
        "only model-API agents can run before the runner arrives (M2)",
        "route_unavailable",
      );
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

    const resolved = await ctx.pricing.lookup({
      presetKey: cc.presetKey,
      model: agent.model,
      override: agent.priceOverride ?? null,
    });
    if (resolved.kind === "unknown" && !cc.preset.reportsCost)
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
      instructions: renderInstructions(task, contract, mission.goal),
      contract,
      handoffs: [],
      brief: EMPTY_BRIEF,
      attachments: [],
      limits,
      mcpServers: [],
    };
    const estimate = await adapter
      .estimate({ ...runInput, attemptId: "estimate" }, agentConfig)
      .catch(() => null);

    const attempt = await ctx.db.transaction(async (tx) => {
      // Lock the task so two clicks cannot start two attempts.
      const [locked] = await tx
        .update(tasks)
        .set({ status: "running", pinnedAgentId: agent.id })
        .where(and(eq(tasks.id, task.id), inArray(tasks.status, [...RUNNABLE_TASK])))
        .returning();
      if (!locked) throw new HttpError(409, "the task is already running", "task_busy");
      const row = one(
        await tx
          .insert(attempts)
          .values({
            workspaceId: input.workspaceId,
            taskId: task.id,
            agentId: agent.id,
            role: "maker",
            status: "running",
            sandboxId: null,
            startedAt: new Date(),
          })
          .returning(),
        "attempt",
      );
      await ctx.events.append(tx, {
        workspaceId: input.workspaceId,
        missionId: mission.id,
        taskId: task.id,
        attemptId: row.id,
        type: "attempt.started",
        actor,
        payload: {
          taskKey: task.key,
          agent: { id: agent.id, name: agent.name, model: agent.model },
          connector: { id: connector.id, registryKey: connector.registryKey, preset: cc.presetKey },
          route: adapter.route,
          price:
            resolved.kind === "unknown"
              ? { kind: "vendor_reported" }
              : { kind: resolved.kind, ...resolved.price },
          estimate,
          limits,
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
          estimateUsd: estimate?.usd ?? null,
          limitUsd: limits.maxCostUsd,
          by: actor,
        },
      });
      return row;
    });

    const abort = new AbortController();
    const done = this.execute(attempt, {
      missionId: mission.id,
      task,
      agentConfig,
      runInput,
      connector,
      adapter,
      abort,
    })
      .catch((err) => ctx.log.error({ err, attemptId: attempt.id }, "attempt bookkeeping failed"))
      .finally(() => this.running.delete(attempt.id));
    this.running.set(attempt.id, { abort, done });
    return attempt;
  }

  /** Cancels a running attempt. Resolves once the attempt is recorded as finished. */
  async cancel(attemptId: string, workspaceId: string): Promise<boolean> {
    const [row] = await this.ctx.db
      .select({ id: attempts.id })
      .from(attempts)
      .where(and(eq(attempts.id, attemptId), eq(attempts.workspaceId, workspaceId)));
    if (!row) throw new HttpError(404, "attempt not found", "not_found");
    const r = this.running.get(attemptId);
    if (!r) return false;
    r.abort.abort();
    await r.done;
    return true;
  }

  /** Waits for an attempt to finish (tests, shutdown). */
  async settled(attemptId: string): Promise<void> {
    await this.running.get(attemptId)?.done;
  }

  /** On shutdown: cancel everything and wait for the bookkeeping. */
  async drain(): Promise<void> {
    for (const r of this.running.values()) r.abort.abort();
    await Promise.all([...this.running.values()].map((r) => r.done));
  }

  /**
   * On startup: attempts left running by a crashed process can never finish (their process is gone). Mark them failed
   * with an event, so the board and budgets see the truth. The scheduler (M3) resumes instead.
   */
  async recoverInterrupted(): Promise<number> {
    const stale = await this.ctx.db
      .select({ attempt: attempts, missionId: tasks.missionId })
      .from(attempts)
      .innerJoin(tasks, eq(tasks.id, attempts.taskId))
      .where(eq(attempts.status, "running"));
    for (const { attempt, missionId } of stale) {
      if (this.running.has(attempt.id)) continue;
      await this.ctx.db.transaction(async (tx) => {
        await tx
          .update(attempts)
          .set({
            status: "failed",
            endedAt: new Date(),
            exitReason: "interrupted: the API restarted mid-run",
          })
          .where(eq(attempts.id, attempt.id));
        await tx
          .update(tasks)
          .set({ status: "failed" })
          .where(and(eq(tasks.id, attempt.taskId), eq(tasks.status, "running")));
        await this.ctx.events.append(tx, {
          workspaceId: attempt.workspaceId,
          missionId,
          taskId: attempt.taskId,
          attemptId: attempt.id,
          type: "attempt.finished",
          actor: "system",
          payload: { status: "failed", exitReason: "interrupted: the API restarted mid-run" },
        });
      });
    }
    return stale.length;
  }

  private async execute(
    attempt: AttemptRow,
    run: {
      missionId: string;
      task: typeof tasks.$inferSelect;
      agentConfig: AgentConfig;
      runInput: Omit<RunInput, "attemptId">;
      connector: typeof connectors.$inferSelect;
      adapter: ReturnType<typeof adapterOf>;
      abort: AbortController;
    },
  ): Promise<void> {
    const { ctx } = this;
    const base = {
      workspaceId: attempt.workspaceId,
      missionId: run.missionId,
      taskId: attempt.taskId,
      attemptId: attempt.id,
    };
    // Adapter events arrive synchronously; append them in order without blocking the adapter.
    let chain: Promise<unknown> = Promise.resolve();
    let spent = 0;
    const append = (
      type: EventType,
      payload: Record<string, unknown>,
      actor: Actor = `agent:${run.agentConfig.agentId}`,
    ) => {
      chain = chain
        .then(() => ctx.events.append(ctx.db, { ...base, type, actor, payload }))
        .catch((err) => ctx.log.error({ err, attemptId: attempt.id, type }, "event append failed"));
    };
    const emit = (e: AdapterEvent) => {
      switch (e.kind) {
        case "message":
          return append("attempt.message", { role: e.role, text: e.text });
        case "tool_call":
          return append("attempt.tool_call", { name: e.name, args: e.args });
        case "file_edit":
          return append("attempt.file_edit", { path: e.path, op: e.op });
        case "cost":
          spent += e.usd;
          return append("attempt.cost", {
            usd: e.usd,
            totalUsd: Math.round(spent * 1e6) / 1e6,
            tokensIn: e.tokensIn ?? 0,
            tokensOut: e.tokensOut ?? 0,
            usage: e.usage ?? null,
            model: e.model ?? run.agentConfig.model,
            priceSource: e.priceSource ?? null,
            price: run.agentConfig.price,
          });
        case "progress":
          return append("attempt.message", { role: "progress", text: e.note });
        case "needs_input":
          return append("message.sent", { kind: "question", to: "user", body: e.question });
      }
    };

    const timer = setTimeout(
      () => run.abort.abort(new LimitExceeded(`ran past the ${run.runInput.limits.maxMinutes}-minute limit`)),
      run.runInput.limits.maxMinutes * 60_000,
    );
    let result: RunResult;
    try {
      const credential = await credentialOf(ctx, run.connector);
      result = await run.adapter.run({ ...run.runInput, attemptId: attempt.id }, run.agentConfig, {
        credential,
        emit,
        signal: run.abort.signal,
        sandbox: NO_SANDBOX,
        logger: redactingLogger(pinoSink(ctx.log), ctx.redactor, { attemptId: attempt.id }),
        fetch: ctx.fetch,
      });
    } catch (err) {
      result = {
        status: "failed",
        summary: "",
        output: "",
        artifacts: [],
        usage: { usd: spent, tokensIn: 0, tokensOut: 0, seconds: 0 },
        tokens: {
          inputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
        error: ctx.redactor.redact((err as Error).message),
      };
    } finally {
      clearTimeout(timer);
    }
    await chain;

    const status =
      result.status === "completed" ? "succeeded" : result.status === "cancelled" ? "cancelled" : "failed";
    const exitReason =
      result.status === "completed"
        ? "completed"
        : `${result.status}${result.error ? `: ${result.error}` : ""}`;
    await ctx.db.transaction(async (tx) => {
      const artifactId = result.output ? await this.storeAnswer(tx, attempt, result.output) : null;
      await tx
        .update(attempts)
        .set({
          status,
          endedAt: new Date(),
          costUsd: result.usage.usd,
          tokensIn: result.usage.tokensIn,
          tokensOut: result.usage.tokensOut,
          exitReason: exitReason.slice(0, 2000),
          transcriptRef: result.vendorRunId ?? null,
        })
        .where(eq(attempts.id, attempt.id));
      await tx
        .update(tasks)
        .set({
          // Succeeded work waits for its acceptance checks (the verifier arrives in M5; until then a human checks).
          status: status === "succeeded" ? "verifying" : "failed",
          ...(artifactId ? { resultArtifactId: artifactId } : {}),
        })
        .where(eq(tasks.id, attempt.taskId));
      await ctx.events.append(tx, {
        ...base,
        type: "attempt.finished",
        actor: `agent:${run.agentConfig.agentId}`,
        payload: {
          status,
          exitReason,
          summary: result.summary,
          usage: result.usage,
          tokens: result.tokens,
          artifactId,
          vendorRunId: result.vendorRunId ?? null,
        },
      });
      if (result.usage.usd > 0)
        await ctx.ledger.append(tx, {
          workspaceId: attempt.workspaceId,
          kind: "spend",
          payload: {
            attemptId: attempt.id,
            missionId: run.missionId,
            agentId: run.agentConfig.agentId,
            model: run.agentConfig.model,
            usd: result.usage.usd,
            tokensIn: result.usage.tokensIn,
            tokensOut: result.usage.tokensOut,
          },
        });
    });
  }

  private async storeAnswer(tx: DbOrTx, attempt: AttemptRow, text: string): Promise<string> {
    const bytes = Buffer.from(text, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await tx
      .insert(blobs)
      .values({
        workspaceId: attempt.workspaceId,
        sha256,
        contentType: "text/markdown; charset=utf-8",
        size: bytes.length,
        bytes,
      })
      .onConflictDoNothing();
    const row = one(
      await tx
        .insert(artifacts)
        .values({
          workspaceId: attempt.workspaceId,
          kind: "report",
          storageRef: `blob:${sha256}`,
          sha256,
          meta: { contentType: "text/markdown", size: bytes.length, source: "agent answer" },
          attemptId: attempt.id,
        })
        .returning({ id: artifacts.id }),
      "artifact",
    );
    return row.id;
  }
}
