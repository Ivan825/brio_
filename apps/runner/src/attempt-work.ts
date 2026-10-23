// The work of one attempt, apart from where its results are kept (ARCHITECTURE §4.3): prepare a worktree and sandbox
// when the dispatch asks for one, run the adapter with its credential and tools, turn its events into Brio events, and
// collect the diff. The cloud runner records the outcome in the database itself; the local runner (M8) does this work
// on the person's machine and sends the outcome to the API, which records it the same way (recordAttemptFinish).
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type AdapterEvent,
  type AgentAdapter,
  cloudBrowserProvider,
  type Dispatch,
  type FetchLike,
  fetchProvider,
  LimitExceeded,
  type Logger,
  type McpServerConfig,
  NO_SANDBOX,
  type RunResult,
  type SandboxHandle,
  type SecretHandle,
  searchProvider,
  type ToolProviders,
} from "@brio/adapters";
import { probeMedia } from "@brio/core";
import { type Db, type DbOrTx, type EventWriter, schema } from "@brio/db";
import type { Ledger } from "@brio/governance";
import type { Actor, EventType } from "@brio/schema";
import type { Redactor } from "@brio/vault";
import { eq } from "drizzle-orm";
import type { CollectedResult, PreparedWorktree, Worktrees } from "./worktree";

const { attempts, artifacts, blobs, tasks } = schema;

export const ZERO_RESULT = (error: string, usd = 0): RunResult => ({
  status: "failed",
  summary: "",
  output: "",
  artifacts: [],
  usage: { usd, tokensIn: 0, tokensOut: 0, seconds: 0 },
  tokens: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 },
  error,
});

/** A sandbox the work runs in: Docker in the cloud and in the local runner's default mode, the host in restricted mode. */
export type WorkSandbox = SandboxHandle & {
  readonly name: string;
  kill(): Promise<void>;
  destroy(): Promise<void>;
};

/** Where the attempt's events and milestones go: the database (cloud runner) or the API (local runner). */
export interface WorkSink {
  event(type: EventType, payload: Record<string, unknown>, actor?: Actor): void;
  /** The vendor's id for the run, as soon as it exists. */
  vendorRun(id: string): void;
  /** The worktree and sandbox exist: the attempt's branch and the sandbox's name. */
  ready(info: { branch: string; sandbox: string }): Promise<void>;
  /** Waits for everything sent so far. */
  flush(): Promise<void>;
}

/** The mailbox (ask_agent and friends) for one attempt, if this runner can offer it. */
export interface WorkMailbox {
  tools: NonNullable<ToolProviders["mailbox"]>;
  /** For CLI agents: the MCP server they reach it at, and the port the sandbox's proxy relays to. */
  cli?: { server: McpServerConfig; port: number };
  release(): void;
}

export interface WorkEnv {
  worktrees: Worktrees;
  sandbox(i: {
    attemptId: string;
    spec: NonNullable<Dispatch["sandbox"]>;
    image: Dispatch["image"];
    worktree: string;
    mailboxPort?: number;
  }): Promise<WorkSandbox>;
  /** A credential by its vault reference (null when the reference is null). */
  secret(ref: string | null | undefined): Promise<SecretHandle | null>;
  fetch: FetchLike;
  log: Logger;
  redactor: Redactor;
  resolveAdapter(key: string): AgentAdapter | undefined;
  /** Opens the attempt's mailbox; research tools are filled in once they are metered. */
  mailbox?(research: Pick<ToolProviders, "search" | "fetch" | "browser">): WorkMailbox | null;
}

export interface WorkOutcome {
  result: RunResult;
  worktree: PreparedWorktree | null;
  collected: CollectedResult | null;
}

/** Runs one attempt's work. Never throws for the agent's failures: they are the result. */
export async function runAttemptWork(
  attempt: { id: string; workspaceId: string; taskId: string },
  dispatch: Dispatch,
  env: WorkEnv,
  sink: WorkSink,
  abort: AbortController,
): Promise<WorkOutcome> {
  let spent = 0;
  const adapter = env.resolveAdapter(dispatch.adapterKey);
  const research: Pick<ToolProviders, "search" | "fetch" | "browser"> = {};
  const mailbox = env.mailbox?.(research) ?? null;
  let worktree: PreparedWorktree | null = null;
  let sandbox: WorkSandbox | null = null;
  let result: RunResult;
  let collected: CollectedResult | null = null;
  const timer = setTimeout(
    () => abort.abort(new LimitExceeded(`ran past the ${dispatch.input.limits.maxMinutes}-minute limit`)),
    (dispatch.sandbox?.timeoutMinutes ?? dispatch.input.limits.maxMinutes) * 60_000,
  );
  // The project's git token, revealed only to fetch a private repository into the runner's cache.
  const repoToken = async () => (await env.secret(dispatch.repo?.credentialRef))?.reveal() ?? null;
  try {
    if (!adapter) throw new Error(`no adapter ${dispatch.adapterKey}`);
    let handle: SandboxHandle = NO_SANDBOX;
    if (dispatch.sandbox) {
      sink.event("attempt.message", { role: "progress", text: "preparing worktree and sandbox" }, "system");
      worktree = await env.worktrees.prepare({
        attemptId: attempt.id,
        missionId: dispatch.missionId,
        taskKey: dispatch.taskKey,
        repo: dispatch.repo,
        token: await repoToken(),
        ...(dispatch.bases?.length ? { bases: dispatch.bases } : {}),
        ...(dispatch.keepConflicts ? { keepConflicts: true } : {}),
      });
      // (A merge task's conflicts are in its instructions; the markers are in the files.)
      // What Brio hands the agent (handoff packets, the contract) goes in .brio/, which never enters the diff.
      for (const f of dispatch.files ?? []) {
        const target = join(worktree.path, ".brio", f.path.replace(/^\.brio\//, ""));
        if (!target.startsWith(join(worktree.path, ".brio"))) continue;
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, f.encoding === "base64" ? Buffer.from(f.content, "base64") : f.content);
      }
      if (abort.signal.aborted) throw abort.signal.reason;
      sandbox = await env.sandbox({
        attemptId: attempt.id,
        spec: dispatch.sandbox,
        image: dispatch.image,
        worktree: worktree.path,
        ...(mailbox?.cli ? { mailboxPort: mailbox.cli.port } : {}),
      });
      handle = sandbox;
      await sink.ready({ branch: worktree.branch, sandbox: sandbox.name });
      // A cancel or limit stops everything inside the sandbox at once.
      abort.signal.addEventListener("abort", () => void sandbox?.kill(), { once: true });
    }

    const input = {
      ...dispatch.input,
      attemptId: attempt.id,
      repo: dispatch.repo ? { url: dispatch.repo.url, branch: dispatch.repo.branch } : null,
    };
    if (dispatch.repoMap) {
      // The planner's repo map: the repository's file list, read from the runner's trusted cache.
      const cache = await env.worktrees.cache(
        dispatch.repo ? { repo: dispatch.repo } : { missionId: dispatch.missionId },
        { token: await repoToken() },
      );
      const ref = dispatch.repo?.branch ? `refs/heads/${dispatch.repo.branch}` : "HEAD";
      const files = await env.worktrees.listFiles(cache, ref).catch(() => []);
      input.attachments = [
        ...input.attachments,
        {
          kind: "repo-map",
          ref: `repository files (${files.length})`,
          text: files.length ? files.join("\n") : "(empty repository)",
        },
      ];
    }
    const credential = await env.secret(dispatch.credentialRef);
    const emit = (e: AdapterEvent) => {
      const m = brioEventOf(e, dispatch, () => spent);
      if (e.kind === "cost") spent += e.usd;
      if (e.kind === "vendor_run") sink.vendorRun(e.id);
      if (m) sink.event(m.type, m.kind === "cost" ? { ...m.payload, totalUsd: round6(spent) } : m.payload);
    };
    for (const kind of ["search", "fetch", "browser"] as const) {
      const ref = dispatch.tools?.[kind];
      if (!ref) continue;
      const binding = { connector: ref.connector, usdPerUnit: ref.usdPerUnit };
      const toolCtx = {
        credential: await env.secret(ref.credentialRef),
        fetch: env.fetch,
        // A tool call is spend like any other: metered on the attempt and held to its limit.
        meter: (usd: number, note: string) => {
          emit({ kind: "cost", usd, model: note, priceSource: "vendor" });
          if (spent > dispatch.input.limits.maxCostUsd && !abort.signal.aborted)
            abort.abort(
              new LimitExceeded(
                `spent $${spent.toFixed(2)}, over the $${dispatch.input.limits.maxCostUsd} limit`,
              ),
            );
        },
      };
      if (kind === "search") research.search = searchProvider(binding, toolCtx);
      else if (kind === "fetch") research.fetch = fetchProvider(binding, toolCtx);
      else research.browser = cloudBrowserProvider(binding, toolCtx);
    }
    // The agent's MCP servers, with their credentials (in memory only; the redactor knows them).
    for (const m of dispatch.mcp ?? []) {
      const cred = await env.secret(m.credentialRef);
      input.mcpServers = [
        ...input.mcpServers,
        {
          name: m.name,
          transport: "http",
          url: m.url,
          ...(cred ? { headers: { Authorization: `Bearer ${cred.reveal()}` } } : {}),
        },
      ];
    }
    if (mailbox?.cli) input.mcpServers = [...input.mcpServers, mailbox.cli.server];
    result = await adapter.run(input, dispatch.agent, {
      credential,
      emit,
      signal: abort.signal,
      sandbox: handle,
      logger: env.log,
      fetch: env.fetch,
      tools: { ...(mailbox ? { mailbox: mailbox.tools } : {}), ...research },
    });
  } catch (err) {
    const reason = abort.signal.aborted
      ? abort.signal.reason instanceof LimitExceeded
        ? `limit_exceeded: ${(abort.signal.reason as Error).message}`
        : "cancelled"
      : env.redactor.redact((err as Error).message);
    result = {
      ...ZERO_RESULT(reason, spent),
      status: abort.signal.aborted && reason === "cancelled" ? "cancelled" : "failed",
    };
  } finally {
    clearTimeout(timer);
    mailbox?.release();
  }

  if (sandbox) await sandbox.destroy().catch(() => {});
  // Files the agent produced outside the worktree (generated media) that belong in the repository go in before
  // the result is collected, so they are part of the diff the next tasks build on.
  if (worktree && result.status === "completed")
    for (const f of result.files ?? []) {
      if (!f.path) continue;
      const target = join(worktree.path, f.path);
      if (!target.startsWith(`${worktree.path}/`) || f.path.split("/").includes(".git")) continue;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, f.bytes);
    }
  if (worktree) {
    try {
      collected = await env.worktrees.collect(
        worktree,
        attempt.id,
        `${dispatch.taskKey}: attempt ${attempt.id.slice(0, 8)} by ${dispatch.agent.name}`,
      );
      for (const f of collected.files)
        sink.event("attempt.file_edit", {
          path: f.path,
          op: f.status === "added" ? "create" : f.status === "deleted" ? "delete" : "modify",
          sha256: f.sha256 ?? null,
        });
    } catch (err) {
      env.log.error({ err: (err as Error).message, attemptId: attempt.id }, "collecting the worktree failed");
    }
    await env.worktrees.remove(worktree).catch(() => {});
  }
  await sink.flush();
  return { result, worktree, collected };
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** An adapter event as a Brio event (vendor_run is not one: it is recorded on the attempt). */
export function brioEventOf(
  e: AdapterEvent,
  dispatch: Dispatch,
  spent: () => number,
): { type: EventType; payload: Record<string, unknown>; kind: AdapterEvent["kind"] } | null {
  switch (e.kind) {
    case "vendor_run":
      return null;
    case "message":
      return { kind: e.kind, type: "attempt.message", payload: { role: e.role, text: e.text } };
    case "tool_call":
      return { kind: e.kind, type: "attempt.tool_call", payload: { name: e.name, args: e.args } };
    case "file_edit":
      return { kind: e.kind, type: "attempt.file_edit", payload: { path: e.path, op: e.op } };
    case "cost":
      return {
        kind: e.kind,
        type: "attempt.cost",
        payload: {
          usd: e.usd,
          totalUsd: round6(spent() + e.usd),
          tokensIn: e.tokensIn ?? 0,
          tokensOut: e.tokensOut ?? 0,
          usage: e.usage ?? null,
          model: e.model ?? dispatch.agent.model,
          priceSource: e.priceSource ?? null,
          price: dispatch.agent.price,
        },
      };
    case "progress":
      return { kind: e.kind, type: "attempt.message", payload: { role: "progress", text: e.note } };
    case "needs_input":
      return {
        kind: e.kind,
        type: "message.sent",
        payload: { kind: "question", to: "user", body: e.question },
      };
  }
}

export interface RecordDeps {
  db: Db;
  events: EventWriter;
  ledger: Ledger;
  redactor: Redactor;
  log: Logger;
}

/** Produced files per attempt, and the size of each (blobs live in Postgres until object storage, D-35). */
const MAX_PRODUCED_FILES = 20;
const MAX_PRODUCED_BYTES = 50 * 1024 * 1024;

/**
 * Records an attempt's outcome: its answer, produced files and diff as content-addressed artifacts, its status and
 * usage, the task's next status, the attempt.finished event and the spend in the ledger — in one transaction.
 */
export async function recordAttemptFinish(
  deps: RecordDeps,
  attempt: { id: string; workspaceId: string; taskId: string },
  dispatch: Dispatch | null,
  result: RunResult,
  worktree: Pick<PreparedWorktree, "branch" | "base"> | null,
  collected: CollectedResult | null,
): Promise<void> {
  const status =
    result.status === "completed" ? "succeeded" : result.status === "cancelled" ? "cancelled" : "failed";
  const exitReason =
    result.status === "completed"
      ? "completed"
      : `${result.status}${result.error ? `: ${result.error}` : ""}`;
  const missionId =
    dispatch?.missionId ??
    (await deps.db.select({ missionId: tasks.missionId }).from(tasks).where(eq(tasks.id, attempt.taskId)))[0]
      ?.missionId ??
    null;
  await deps.db.transaction(async (tx) => {
    const store = (
      kind: "report" | "diff" | "file" | "image" | "video" | "audio",
      raw: Buffer,
      contentType: string,
      meta: Record<string, unknown>,
    ) => storeArtifact(tx, deps.redactor, attempt, kind, raw, contentType, meta);
    const answerId = result.output
      ? await store("report", Buffer.from(result.output, "utf8"), "text/markdown; charset=utf-8", {
          source: "agent answer",
        })
      : null;
    // Produced files (media, hosted outputs) are artifacts of their own kind, with what their headers say.
    const producedIds: string[] = [];
    for (const f of (result.files ?? []).slice(0, MAX_PRODUCED_FILES)) {
      if (f.bytes.length > MAX_PRODUCED_BYTES) {
        deps.log.warn(
          { attemptId: attempt.id, name: f.name, bytes: f.bytes.length },
          "produced file over the size limit; not stored",
        );
        continue;
      }
      const probe = f.kind === "file" ? null : probeMedia(f.bytes);
      producedIds.push(
        await store(f.kind, Buffer.from(f.bytes), f.contentType, {
          name: f.name,
          ...(f.path ? { path: f.path } : {}),
          ...(probe && probe.format !== "unknown" ? { media: probe } : {}),
          ...(f.meta ?? {}),
        }),
      );
    }
    let diffId: string | null = null;
    if (collected?.commit) {
      diffId = await store("diff", collected.diff, "text/x-diff; charset=utf-8", {
        branch: worktree?.branch,
        base: worktree?.base,
        commit: collected.commit,
        truncated: collected.diffTruncated,
        files: collected.files.map(({ path, status, sha256, size }) => ({ path, status, sha256, size })),
      });
      for (const f of collected.files)
        if (f.content)
          await store("file", f.content, "application/octet-stream", { path: f.path, status: f.status });
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
    // Succeeded work waits for its acceptance checks. In multi-agent modes the orchestrator owns the task's status.
    if (dispatch?.manageTask !== false)
      await tx
        .update(tasks)
        .set({
          status: status === "succeeded" ? "verifying" : status === "cancelled" ? "ready" : "failed",
          ...((diffId ?? producedIds[0] ?? answerId)
            ? { resultArtifactId: diffId ?? producedIds[0] ?? answerId }
            : {}),
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

/**
 * Stores bytes content-addressed and records an artifact. Output that contains a secret is quarantined
 * (SECURITY_GOVERNANCE §2): the stored copy is redacted and the artifact is flagged.
 */
export async function storeArtifact(
  tx: DbOrTx,
  redactor: Redactor,
  attempt: { id: string; workspaceId: string },
  kind: "report" | "diff" | "file" | "image" | "video" | "audio",
  raw: Buffer,
  contentType: string,
  meta: Record<string, unknown>,
): Promise<string> {
  let bytes = raw;
  let quarantined = false;
  if (!contentType.startsWith("application/octet-stream") || isProbablyText(raw)) {
    const text = raw.toString("utf8");
    const clean = redactor.redact(text);
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

function isProbablyText(b: Buffer): boolean {
  return !b.subarray(0, 8000).includes(0);
}
