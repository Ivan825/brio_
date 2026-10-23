// The merge engine's runner side (BUILD_PLAN M5): merge the finished code branches of a mission, in plan order, onto
// an integration branch in the trusted repository cache, then run every hard command check on the result in a fresh
// sandbox. The orchestrator turns a conflict into a merge.integrate task and a failing check into a fix task.
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Logger } from "@brio/adapters";
import { type Db, type EventWriter, schema } from "@brio/db";
import type { Redactor } from "@brio/vault";
import { and, eq } from "drizzle-orm";
import { CHECK_SANDBOX } from "./checks";
import { ensureImage, type ImageSet } from "./images";
import { DockerSandbox } from "./sandbox/docker-sandbox";
import { MergeConflictError, Worktrees } from "./worktree";

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
    const event = (
      type: "merge.started" | "merge.conflict" | "merge.done",
      payload: Record<string, unknown>,
    ) =>
      deps.events.append(deps.db, {
        workspaceId: row.workspaceId,
        missionId: row.missionId,
        type,
        actor: "system",
        payload: { integrationId: row.id, round: row.round, ...payload },
      });
    const finish = (set: Partial<typeof integrations.$inferInsert>) =>
      deps.db.update(integrations).set(set).where(eq(integrations.id, row.id));

    let worktree: Awaited<ReturnType<Worktrees["prepare"]>> | null = null;
    let sandbox: DockerSandbox | null = null;
    try {
      // The branches to merge are already in the cache; nothing new is needed from the remote.
      const cache = await this.worktrees.cache(row.repo ? { repo: row.repo } : { missionId: row.missionId }, {
        fetch: false,
      });
      const branches = row.refs.map((r) => r.ref);
      let merged: { commit: string };
      try {
        merged = await this.worktrees.mergeBranches(cache, branches);
      } catch (err) {
        if (!(err instanceof MergeConflictError)) throw err;
        const keyOf = new Map(row.refs.map((r) => [r.ref, r.taskKey]));
        const conflict = {
          between: err.conflict.between.map((b) => keyOf.get(b) ?? b) as [string, string],
          files: err.conflict.files,
        };
        await finish({ status: "conflict", conflicts: [conflict] });
        await event("merge.conflict", { between: conflict.between, files: conflict.files });
        return;
      }

      const branch = `brio/${row.missionId.slice(0, 8)}/integration-v${row.planVersion}-r${row.round}`;
      await this.worktrees.git(["--git-dir", cache, "update-ref", `refs/heads/${branch}`, merged.commit]);
      const base = await this.baseOf(cache, row.repo?.branch ?? null);
      const diff = (
        await this.worktrees.git([
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
      const diffArtifactId = await this.storeDiff(row.workspaceId, row.id, diff, {
        branch,
        commit: merged.commit,
        base,
      });

      const checks: Array<{ command: string; passed: boolean; exitCode: number | null; output: string }> = [];
      if (job.commands.length) {
        worktree = await this.worktrees.prepare({
          attemptId: `integration-${row.id}`,
          missionId: row.missionId,
          taskKey: "integration",
          bases: [branch],
          cacheOverride: cache,
        });
        sandbox = await DockerSandbox.create({
          attemptId: `integration-${row.id}`,
          runnerId: deps.runnerId,
          spec: CHECK_SANDBOX,
          image: await ensureImage(deps.images, "base"),
          images: { ...deps.images, proxy: await ensureImage(deps.images, "proxy") },
          worktree: worktree.path,
          scratchDir: join(deps.dir, "scratch"),
          ...(deps.proxyAllowPrivate ? { proxyAllowPrivate: true } : {}),
        });
        for (const command of job.commands) {
          if (signal?.aborted) break;
          const r = await sandbox.exec(command, { timeoutMs: 10 * 60_000 });
          const raw = `${r.stdout}\n${r.stderr}`.trim();
          checks.push({
            command,
            passed: r.exitCode === 0,
            exitCode: r.exitCode,
            output: deps.redactor.redact(raw.length > OUTPUT_TAIL ? raw.slice(-OUTPUT_TAIL) : raw),
          });
        }
      }
      const passed = checks.every((c) => c.passed);
      await finish({
        status: passed ? "passed" : "failed",
        branch,
        commit: merged.commit,
        base,
        checks,
        diffArtifactId,
      });
      await event("merge.done", {
        passed,
        branch,
        commit: merged.commit,
        checks: checks.map((c) => ({ command: c.command, passed: c.passed })),
      });
    } catch (err) {
      const message = deps.redactor.redact((err as Error).message).slice(0, 2000);
      await finish({ status: "failed", error: message });
      await event("merge.done", { passed: false, error: message });
    } finally {
      await sandbox?.destroy().catch(() => {});
      if (worktree) await this.worktrees.remove(worktree).catch(() => {});
    }
  }

  /** Where the mission's work started: the project's branch, or the mission repository's first commit. */
  private async baseOf(cache: string, branch: string | null): Promise<string> {
    const ref = branch
      ? `refs/heads/${branch}`
      : (await this.worktrees.git(["--git-dir", cache, "symbolic-ref", "HEAD"]).catch(() => null))?.stdout
          .toString("utf8")
          .trim() || "refs/heads/main";
    return (await this.worktrees.git(["--git-dir", cache, "rev-parse", "--verify", `${ref}^{commit}`])).stdout
      .toString("utf8")
      .trim();
  }

  private async storeDiff(
    workspaceId: string,
    integrationId: string,
    diff: Buffer,
    meta: Record<string, unknown>,
  ) {
    if (!diff.length) return null;
    const sha256 = createHash("sha256").update(diff).digest("hex");
    return this.deps.db.transaction(async (tx) => {
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
}
