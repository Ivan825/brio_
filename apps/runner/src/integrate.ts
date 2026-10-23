// The merge engine's runner side (BUILD_PLAN M5): merge the finished code branches of a mission, in plan order, onto
// an integration branch in the trusted repository cache, then run every hard command check on the result in a fresh
// sandbox. The orchestrator turns a conflict into a merge.integrate task and a failing check into a fix task. The work
// (mergeWork) is apart from recording it (recordMerge), so a local runner (M8) can merge on the person's machine.
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Logger } from "@brio/adapters";
import { type Db, type EventWriter, schema } from "@brio/db";
import type { Redactor } from "@brio/vault";
import { and, eq } from "drizzle-orm";
import type { WorkSandbox } from "./attempt-work";
import { CHECK_SANDBOX } from "./checks";
import { ensureImage, type ImageSet } from "./images";
import { DockerSandbox } from "./sandbox/docker-sandbox";
import { type MergeConflict, MergeConflictError, Worktrees } from "./worktree";

const { artifacts, blobs, integrations } = schema;
const OUTPUT_TAIL = 4000;

export interface IntegrationDeps {
  db: Db;
  events: EventWriter;
  redactor: Redactor;
  log: Logger;
  runnerId: string;
  dir: string;
  images: ImageSet;
  proxyAllowPrivate?: boolean;
}

export interface IntegrationJob {
  integrationId: string;
  /** The hard command checks of the merged tasks, de-duplicated. */
  commands: string[];
}

/** What a merge round needs to know. */
export interface MergeInput {
  id: string;
  missionId: string;
  planVersion: number;
  round: number;
  refs: Array<{ taskId: string; taskKey: string; ref: string }>;
  repo: { url: string; branch: string | null } | null;
}

export type MergeCheck = { command: string; passed: boolean; exitCode: number | null; output: string };

export type MergeOutcome =
  | { status: "conflict"; conflict: MergeConflict }
  | {
      status: "passed" | "failed";
      branch: string;
      commit: string;
      base: string;
      diff: Buffer;
      checks: MergeCheck[];
    }
  | { status: "error"; error: string };

/** Merges the round's branches and runs its commands on the result. Never throws: errors are an outcome. */
export async function mergeWork(
  env: {
    worktrees: Worktrees;
    redactor: Redactor;
    sandbox(i: { id: string; worktree: string }): Promise<WorkSandbox>;
  },
  row: MergeInput,
  commands: string[],
  signal?: AbortSignal,
): Promise<MergeOutcome> {
  let worktree: Awaited<ReturnType<Worktrees["prepare"]>> | null = null;
  let sandbox: WorkSandbox | null = null;
  try {
    // The branches to merge are already in the cache; nothing new is needed from the remote.
    const cache = await env.worktrees.cache(row.repo ? { repo: row.repo } : { missionId: row.missionId }, {
      fetch: false,
    });
    let merged: { commit: string };
    try {
      merged = await env.worktrees.mergeBranches(
        cache,
        row.refs.map((r) => r.ref),
      );
    } catch (err) {
      if (!(err instanceof MergeConflictError)) throw err;
      return { status: "conflict", conflict: err.conflict };
    }
    const branch = `brio/${row.missionId.slice(0, 8)}/integration-v${row.planVersion}-r${row.round}`;
    await env.worktrees.git(["--git-dir", cache, "update-ref", `refs/heads/${branch}`, merged.commit]);
    const base = await baseOf(env.worktrees, cache, row.repo?.branch ?? null);
    const diff = (
      await env.worktrees.git([
        "--git-dir",
        cache,
        "diff",
        "--binary",
        "--no-color",
        "--no-ext-diff",
        base,
        merged.commit,
      ])
    ).stdout;
    const checks: MergeCheck[] = [];
    if (commands.length) {
      worktree = await env.worktrees.prepare({
        attemptId: `integration-${row.id}`,
        missionId: row.missionId,
        taskKey: "integration",
        bases: [branch],
        cacheOverride: cache,
      });
      sandbox = await env.sandbox({ id: `integration-${row.id}`, worktree: worktree.path });
      for (const command of commands) {
        if (signal?.aborted) break;
        const r = await sandbox.exec(command, { timeoutMs: 10 * 60_000 });
        const raw = `${r.stdout}\n${r.stderr}`.trim();
        checks.push({
          command,
          passed: r.exitCode === 0,
          exitCode: r.exitCode,
          output: env.redactor.redact(raw.length > OUTPUT_TAIL ? raw.slice(-OUTPUT_TAIL) : raw),
        });
      }
    }
    return {
      status: checks.every((c) => c.passed) ? "passed" : "failed",
      branch,
      commit: merged.commit,
      base,
      diff,
      checks,
    };
  } catch (err) {
    return { status: "error", error: env.redactor.redact((err as Error).message).slice(0, 2000) };
  } finally {
    await sandbox?.destroy().catch(() => {});
    if (worktree) await env.worktrees.remove(worktree).catch(() => {});
  }
}

/** Where the mission's work started: the project's branch, or the mission repository's first commit. */
async function baseOf(worktrees: Worktrees, cache: string, branch: string | null): Promise<string> {
  const ref = branch
    ? `refs/heads/${branch}`
    : (await worktrees.git(["--git-dir", cache, "symbolic-ref", "HEAD"]).catch(() => null))?.stdout
        .toString("utf8")
        .trim() || "refs/heads/main";
  return (await worktrees.git(["--git-dir", cache, "rev-parse", "--verify", `${ref}^{commit}`])).stdout
    .toString("utf8")
    .trim();
}

/** Records a merge round's outcome on its row, with the merged diff as an artifact and the merge events. */
export async function recordMerge(
  deps: { db: Db; events: EventWriter },
  row: MergeInput & { workspaceId: string },
  outcome: MergeOutcome,
): Promise<void> {
  const event = (type: "merge.conflict" | "merge.done", payload: Record<string, unknown>) =>
    deps.events.append(deps.db, {
      workspaceId: row.workspaceId,
      missionId: row.missionId,
      type,
      actor: "system",
      payload: { integrationId: row.id, round: row.round, ...payload },
    });
  const finish = (set: Partial<typeof integrations.$inferInsert>) =>
    deps.db.update(integrations).set(set).where(eq(integrations.id, row.id));
  if (outcome.status === "conflict") {
    const keyOf = new Map(row.refs.map((r) => [r.ref, r.taskKey]));
    const conflict = {
      between: outcome.conflict.between.map((b) => keyOf.get(b) ?? b) as [string, string],
      files: outcome.conflict.files,
    };
    await finish({ status: "conflict", conflicts: [conflict] });
    await event("merge.conflict", { between: conflict.between, files: conflict.files });
    return;
  }
  if (outcome.status === "error") {
    await finish({ status: "failed", error: outcome.error });
    await event("merge.done", { passed: false, error: outcome.error });
    return;
  }
  const diffArtifactId = await storeDiff(deps.db, row.workspaceId, row.id, outcome.diff, {
    branch: outcome.branch,
    commit: outcome.commit,
    base: outcome.base,
  });
  const passed = outcome.status === "passed";
  await finish({
    status: outcome.status,
    branch: outcome.branch,
    commit: outcome.commit,
    base: outcome.base,
    checks: outcome.checks,
    diffArtifactId,
  });
  await event("merge.done", {
    passed,
    branch: outcome.branch,
    commit: outcome.commit,
    checks: outcome.checks.map((c) => ({ command: c.command, passed: c.passed })),
  });
}

async function storeDiff(
  db: Db,
  workspaceId: string,
  integrationId: string,
  diff: Buffer,
  meta: Record<string, unknown>,
): Promise<string | null> {
  if (!diff.length) return null;
  const sha256 = createHash("sha256").update(diff).digest("hex");
  return db.transaction(async (tx) => {
    await tx
      .insert(blobs)
      .values({
        workspaceId,
        sha256,
        contentType: "text/x-diff; charset=utf-8",
        size: diff.length,
        bytes: diff,
      })
      .onConflictDoNothing();
    const [a] = await tx
      .insert(artifacts)
      .values({
        workspaceId,
        kind: "diff",
        storageRef: `blob:${sha256}`,
        sha256,
        meta: { ...meta, integrationId, bytes: diff.length },
      })
      .returning({ id: artifacts.id });
    return a?.id ?? null;
  });
}

export class IntegrationExecutor {
  private readonly worktrees: Worktrees;
  constructor(private readonly deps: IntegrationDeps) {
    this.worktrees = new Worktrees(deps.dir);
  }

  async run(job: IntegrationJob, signal?: AbortSignal): Promise<void> {
    const { deps } = this;
    // Claim the round (queued → running) so a duplicate job does nothing.
    const [row] = await deps.db
      .update(integrations)
      .set({ status: "running" })
      .where(and(eq(integrations.id, job.integrationId), eq(integrations.status, "queued")))
      .returning();
    if (!row) return;
    const outcome = await mergeWork(
      {
        worktrees: this.worktrees,
        redactor: deps.redactor,
        sandbox: async (i) =>
          DockerSandbox.create({
            attemptId: i.id,
            runnerId: deps.runnerId,
            spec: CHECK_SANDBOX,
            image: await ensureImage(deps.images, "base"),
            images: { ...deps.images, proxy: await ensureImage(deps.images, "proxy") },
            worktree: i.worktree,
            scratchDir: join(deps.dir, "scratch"),
            ...(deps.proxyAllowPrivate ? { proxyAllowPrivate: true } : {}),
          }),
      },
      row,
      job.commands,
      signal,
    );
    await recordMerge(deps, row, outcome);
  }
}
