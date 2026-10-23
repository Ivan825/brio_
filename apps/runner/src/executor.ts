// Executes one queued attempt (ARCHITECTURE §4.3): claim it, prepare a worktree and sandbox when the dispatch asks for
// one, reveal the credential just in time, run the adapter, turn its events into Brio events, collect the diff and
// files as content-addressed artifacts, and record the result. Every step leaves an event; every spend a ledger entry.
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  type AdapterEvent,
  type AgentAdapter,
  adapterFor,
  type Dispatch,
  type FetchLike,
  LimitExceeded,
  type Logger,
  NO_SANDBOX,
  type RunResult,
  type SandboxHandle,
} from "@brio/adapters";
import { type Db, type DbOrTx, type EventWriter, schema } from "@brio/db";
import type { Ledger } from "@brio/governance";
import type { Actor, EventType } from "@brio/schema";
import type { Redactor, Vault } from "@brio/vault";
import { and, eq } from "drizzle-orm";
import { ensureImage, type ImageSet } from "./images";
import { DockerSandbox } from "./sandbox/docker-sandbox";
import { type CollectedResult, type PreparedWorktree, Worktrees } from "./worktree";

const { attempts, artifacts, blobs, tasks } = schema;

export interface ExecutorDeps {
  db: Db;
  events: EventWriter;
  ledger: Ledger;
  vault: Vault;
  redactor: Redactor;
  fetch: FetchLike;
  log: Logger;
  runnerId: string;
  /** Root for worktrees, repo caches and scratch files. */
  dir: string;
  images: ImageSet;
  /** Test-only: lets sandbox proxies reach private addresses. */
  proxyAllowPrivate?: boolean;
  /** Resolves adapter keys; defaults to the registered adapters (tests add fakes). */
  resolveAdapter?: (key: string) => AgentAdapter | undefined;
}

type AttemptRow = typeof attempts.$inferSelect;

export const ZERO_RESULT = (error: string, usd = 0): RunResult => ({
  status: "failed",
  summary: "",
  output: "",
  artifacts: [],
  usage: { usd, tokensIn: 0, tokensOut: 0, seconds: 0 },
  tokens: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 },
  error,
});

export class AttemptExecutor {
  readonly worktrees: Worktrees;

  constructor(private readonly deps: ExecutorDeps) {
    this.worktrees = new Worktrees(deps.dir);
  }

  /** queued → running, atomically. Null when another runner (or a cancel) got there first. */
  async claim(attemptId: string): Promise<AttemptRow | null> {
    const [row] = await this.deps.db
      .update(attempts)
      .set({
        status: "running",
        runnerId: this.deps.runnerId,
        startedAt: new Date(),
        heartbeatAt: new Date(),
      })
      .where(and(eq(attempts.id, attemptId), eq(attempts.status, "queued")))
      .returning();
    return row ?? null;
  }

  async execute(attempt: AttemptRow, abort: AbortController): Promise<void> {
    const { deps } = this;
    const dispatch = attempt.dispatch as unknown as Dispatch | null;
    if (!dispatch || dispatch.version !== 1) {
      await this.finish(attempt, null, ZERO_RESULT("the attempt has no dispatch plan"), null, null);
      return;
    }
    const base = {
      workspaceId: attempt.workspaceId,
      missionId: dispatch.missionId,
      taskId: attempt.taskId,
      attemptId: attempt.id,
    };
    const agentActor: Actor = `agent:${dispatch.agent.agentId}`;
    let chain: Promise<unknown> = Promise.resolve();
    let spent = 0;
    const append = (type: EventType, payload: Record<string, unknown>, actor: Actor = agentActor) => {
      chain = chain
        .then(() => deps.events.append(deps.db, { ...base, type, actor, payload }))
        .catch((err) =>
          deps.log.error({ err: (err as Error).message, attemptId: attempt.id, type }, "event append failed"),
        );
    };

    await deps.db.update(tasks).set({ status: "running" }).where(eq(tasks.id, attempt.taskId));
    append(
      "attempt.started",
      {
        taskKey: dispatch.taskKey,
        agent: { id: dispatch.agent.agentId, name: dispatch.agent.name, model: dispatch.agent.model },
        adapter: dispatch.adapterKey,
        route: dispatch.route,
        runner: deps.runnerId,
        sandbox: dispatch.sandbox
          ? {
              profile: dispatch.sandbox.profile,
              network: dispatch.sandbox.network,
              cpus: dispatch.sandbox.cpus,
              memoryMb: dispatch.sandbox.memoryMb,
            }
          : null,
        limits: dispatch.input.limits,
      },
      "system",
    );

    const adapter = (deps.resolveAdapter ?? adapterFor)(dispatch.adapterKey);
    let worktree: PreparedWorktree | null = null;
    let sandbox: DockerSandbox | null = null;
    let result: RunResult;
    let collected: CollectedResult | null = null;
    const timer = setTimeout(
      () => abort.abort(new LimitExceeded(`ran past the ${dispatch.input.limits.maxMinutes}-minute limit`)),
      (dispatch.sandbox?.timeoutMinutes ?? dispatch.input.limits.maxMinutes) * 60_000,
    );
    try {
      if (!adapter) throw new Error(`no adapter ${dispatch.adapterKey}`);
      let handle: SandboxHandle = NO_SANDBOX;
      if (dispatch.sandbox) {
        append("attempt.message", { role: "progress", text: "preparing worktree and sandbox" }, "system");
        worktree = await this.worktrees.prepare({
          attemptId: attempt.id,
          missionId: dispatch.missionId,
          taskKey: dispatch.taskKey,
          repo: dispatch.repo,
        });
        const image = await ensureImage(deps.images, dispatch.image);
        await ensureImage(deps.images, "proxy");
        if (abort.signal.aborted) throw abort.signal.reason;
        sandbox = await DockerSandbox.create({
          attemptId: attempt.id,
          runnerId: deps.runnerId,
          spec: dispatch.sandbox,
          image,
          images: deps.images,
          worktree: worktree.path,
          scratchDir: join(deps.dir, "scratch"),
          ...(deps.proxyAllowPrivate ? { proxyAllowPrivate: true } : {}),
        });
        handle = sandbox;
        await deps.db
          .update(attempts)
          .set({ sandboxId: sandbox.name, worktreeRef: worktree.branch })
          .where(eq(attempts.id, attempt.id));
        // A cancel or limit stops everything inside the sandbox at once.
        abort.signal.addEventListener("abort", () => void sandbox?.kill(), { once: true });
      }

      const credential = dispatch.credentialRef
        ? await deps.vault.reveal(deps.db, attempt.workspaceId, dispatch.credentialRef)
        : null;
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
              model: e.model ?? dispatch.agent.model,
              priceSource: e.priceSource ?? null,
              price: dispatch.agent.price,
            });
          case "progress":
            return append("attempt.message", { role: "progress", text: e.note });
          case "needs_input":
            return append("message.sent", { kind: "question", to: "user", body: e.question });
        }
      };
      result = await adapter.run({ ...dispatch.input, attemptId: attempt.id }, dispatch.agent, {
        credential,
        emit,
        signal: abort.signal,
        sandbox: handle,
        logger: deps.log,
        fetch: deps.fetch,
      });
    } catch (err) {
      const reason = abort.signal.aborted
        ? abort.signal.reason instanceof LimitExceeded
          ? `limit_exceeded: ${(abort.signal.reason as Error).message}`
          : "cancelled"
        : deps.redactor.redact((err as Error).message);
      result = {
        ...ZERO_RESULT(reason, spent),
        status: abort.signal.aborted && reason === "cancelled" ? "cancelled" : "failed",
      };
    } finally {
      clearTimeout(timer);
    }

    if (sandbox) await sandbox.destroy().catch(() => {});
    if (worktree) {
      try {
        collected = await this.worktrees.collect(
          worktree,
          attempt.id,
          `${dispatch.taskKey}: attempt ${attempt.id.slice(0, 8)} by ${dispatch.agent.name}`,
        );
        for (const f of collected.files)
          append("attempt.file_edit", {
            path: f.path,
            op: f.status === "added" ? "create" : f.status === "deleted" ? "delete" : "modify",
            sha256: f.sha256 ?? null,
          });
      } catch (err) {
        deps.log.error(
          { err: (err as Error).message, attemptId: attempt.id },
          "collecting the worktree failed",
        );
      }
      await this.worktrees.remove(worktree).catch(() => {});
    }
    await chain;
    await this.finish(attempt, dispatch, result, worktree, collected);
  }

  private async finish(
    attempt: AttemptRow,
    dispatch: Dispatch | null,
    result: RunResult,
    worktree: PreparedWorktree | null,
    collected: CollectedResult | null,
  ): Promise<void> {
    const { deps } = this;
    const status =
      result.status === "completed" ? "succeeded" : result.status === "cancelled" ? "cancelled" : "failed";
    const exitReason =
      result.status === "completed"
        ? "completed"
        : `${result.status}${result.error ? `: ${result.error}` : ""}`;
    const missionId = dispatch?.missionId ?? (await this.missionOf(attempt.taskId));
    await deps.db.transaction(async (tx) => {
      const answerId = result.output
        ? await this.store(
            tx,
            attempt,
            "report",
            Buffer.from(result.output, "utf8"),
            "text/markdown; charset=utf-8",
            { source: "agent answer" },
          )
        : null;
      let diffId: string | null = null;
      if (collected?.commit) {
        diffId = await this.store(tx, attempt, "diff", collected.diff, "text/x-diff; charset=utf-8", {
          branch: worktree?.branch,
          base: worktree?.base,
          commit: collected.commit,
          truncated: collected.diffTruncated,
          files: collected.files.map(({ path, status, sha256, size }) => ({ path, status, sha256, size })),
        });
        for (const f of collected.files)
          if (f.content)
            await this.store(tx, attempt, "file", f.content, "application/octet-stream", {
              path: f.path,
              status: f.status,
            });
      }
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
          ...(collected?.commit && worktree ? { worktreeRef: worktree.branch } : {}),
        })
        .where(eq(attempts.id, attempt.id));
      // Succeeded work waits for its acceptance checks (the verifier arrives in M5; until then a human checks).
      await tx
        .update(tasks)
        .set({
          status: status === "succeeded" ? "verifying" : status === "cancelled" ? "ready" : "failed",
          ...((diffId ?? answerId) ? { resultArtifactId: diffId ?? answerId } : {}),
        })
        .where(eq(tasks.id, attempt.taskId));
      if (!missionId) return;
      await deps.events.append(tx, {
        workspaceId: attempt.workspaceId,
        missionId,
        taskId: attempt.taskId,
        attemptId: attempt.id,
        type: "attempt.finished",
        actor: dispatch ? `agent:${dispatch.agent.agentId}` : "system",
        payload: {
          status,
          exitReason,
          summary: result.summary,
          usage: result.usage,
          tokens: result.tokens,
          artifactId: answerId,
          diff: collected?.commit
            ? {
                artifactId: diffId,
                branch: worktree?.branch,
                commit: collected.commit,
                files: collected.files.length,
              }
            : null,
          vendorRunId: result.vendorRunId ?? null,
        },
      });
      if (result.usage.usd > 0)
        await deps.ledger.append(tx, {
          workspaceId: attempt.workspaceId,
          kind: "spend",
          payload: {
            attemptId: attempt.id,
            missionId,
            agentId: dispatch?.agent.agentId ?? null,
            model: dispatch?.agent.model ?? null,
            usd: result.usage.usd,
            tokensIn: result.usage.tokensIn,
            tokensOut: result.usage.tokensOut,
          },
        });
    });
  }

  private async missionOf(taskId: string): Promise<string | null> {
    const [t] = await this.deps.db
      .select({ missionId: tasks.missionId })
      .from(tasks)
      .where(eq(tasks.id, taskId));
    return t?.missionId ?? null;
  }

  /**
   * Stores bytes content-addressed and records an artifact. Output that contains a secret is quarantined
   * (SECURITY_GOVERNANCE §2): the stored copy is redacted and the artifact is flagged.
   */
  private async store(
    tx: DbOrTx,
    attempt: AttemptRow,
    kind: "report" | "diff" | "file",
    raw: Buffer,
    contentType: string,
    meta: Record<string, unknown>,
  ): Promise<string> {
    let bytes = raw;
    let quarantined = false;
    if (!contentType.startsWith("application/octet-stream") || isProbablyText(raw)) {
      const text = raw.toString("utf8");
      const clean = this.deps.redactor.redact(text);
      if (clean !== text) {
        bytes = Buffer.from(clean, "utf8");
        quarantined = true;
      }
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await tx
      .insert(blobs)
      .values({ workspaceId: attempt.workspaceId, sha256, contentType, size: bytes.length, bytes })
      .onConflictDoNothing();
    const [row] = await tx
      .insert(artifacts)
      .values({
        workspaceId: attempt.workspaceId,
        kind,
        storageRef: `blob:${sha256}`,
        sha256,
        meta: {
          ...meta,
          contentType,
          size: bytes.length,
          ...(quarantined ? { quarantined: true, reason: "contained a secret; stored redacted" } : {}),
        },
        attemptId: attempt.id,
      })
      .returning({ id: artifacts.id });
    if (!row) throw new Error("artifact insert returned nothing");
    return row.id;
  }
}

function isProbablyText(b: Buffer): boolean {
  return !b.subarray(0, 8000).includes(0);
}
