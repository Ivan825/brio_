// The command checks of the M3 verifier (tests, typecheck, lint, build): run in a fresh sandbox on the attempt's
// branch, with registry and git access for installs, and nothing else. Each result is an event and is recorded on the
// attempt's checklist (attempts.checks); the orchestrator decides the verdict.

import { join } from "node:path";
import type { AttemptChecks, CheckItem, Dispatch, Logger } from "@brio/adapters";
import { CODE_HOSTS, PROFILES, type SandboxSpec } from "@brio/core";
import { type Db, type EventWriter, schema } from "@brio/db";
import type { Redactor } from "@brio/vault";
import { eq, sql } from "drizzle-orm";
import { ensureImage, type ImageSet } from "./images";
import { DockerSandbox } from "./sandbox/docker-sandbox";
import { Worktrees } from "./worktree";

const { attempts, tasks } = schema;

export const COMMAND_CHECKS = new Set(["tests", "typecheck", "lint", "build"]);
const OUTPUT_TAIL = 4000;

export interface CheckDeps {
  db: Db;
  events: EventWriter;
  redactor: Redactor;
  log: Logger;
  runnerId: string;
  dir: string;
  images: ImageSet;
  proxyAllowPrivate?: boolean;
}

export const CHECK_SANDBOX: SandboxSpec = {
  profile: "code-standard",
  ...PROFILES["code-standard"],
  timeoutMinutes: 20,
  network: { mode: "allowlist", hosts: [...CODE_HOSTS] },
  worktree: "rw",
};

export class CheckExecutor {
  private readonly worktrees: Worktrees;
  constructor(private readonly deps: CheckDeps) {
    this.worktrees = new Worktrees(deps.dir);
  }

  /** Runs the attempt's pending command checks. Safe to call twice: only pending items run. */
  async run(attemptId: string, signal?: AbortSignal): Promise<void> {
    const { deps } = this;
    const [a] = await deps.db.select().from(attempts).where(eq(attempts.id, attemptId));
    const checks = a?.checks as AttemptChecks | null | undefined;
    const dispatch = a?.dispatch as Dispatch | null | undefined;
    if (!a || !checks || !dispatch || !a.worktreeRef) return;
    const pending = checks.items.filter((i) => i.status === "pending" && COMMAND_CHECKS.has(i.kind));
    if (!pending.length) return;
    const [task] = await deps.db
      .select({ missionId: tasks.missionId })
      .from(tasks)
      .where(eq(tasks.id, a.taskId));
    if (!task) return;

    let sandbox: DockerSandbox | null = null;
    const id = `check-${attemptId}`;
    let worktree: Awaited<ReturnType<Worktrees["prepare"]>> | null = null;
    try {
      const cache = await this.worktrees.cache(
        dispatch.repo ? { repo: dispatch.repo } : { missionId: task.missionId },
      );
      worktree = await this.worktrees.prepare({
        attemptId: id,
        missionId: task.missionId,
        taskKey: `${dispatch.taskKey}-checks`,
        bases: [a.worktreeRef],
        cacheOverride: cache,
      });
      sandbox = await DockerSandbox.create({
        attemptId: id,
        runnerId: deps.runnerId,
        spec: CHECK_SANDBOX,
        image: await ensureImage(deps.images, "base"),
        images: { ...deps.images, proxy: await ensureImage(deps.images, "proxy") },
        worktree: worktree.path,
        scratchDir: join(deps.dir, "scratch"),
        ...(deps.proxyAllowPrivate ? { proxyAllowPrivate: true } : {}),
      });
      for (const item of pending) {
        if (signal?.aborted) break;
        const started = performance.now();
        const r = await sandbox.exec(item.command ?? "false", { timeoutMs: 10 * 60_000 });
        const raw = `${r.stdout}\n${r.stderr}`.trim();
        const output = deps.redactor.redact(raw.length > OUTPUT_TAIL ? raw.slice(-OUTPUT_TAIL) : raw);
        const passed = r.exitCode === 0;
        await this.record(attemptId, task.missionId, a.workspaceId, a.taskId, {
          ...item,
          status: passed ? "passed" : "failed",
          exitCode: r.exitCode,
          output,
          durationMs: Math.round(performance.now() - started),
          summary: `${item.command} exited ${r.exitCode}`,
        });
      }
    } catch (err) {
      const message = deps.redactor.redact((err as Error).message);
      for (const item of pending)
        await this.record(attemptId, task.missionId, a.workspaceId, a.taskId, {
          ...item,
          status: "failed",
          summary: `could not run the check: ${message}`,
        });
    } finally {
      await sandbox?.destroy().catch(() => {});
      if (worktree) await this.worktrees.remove(worktree).catch(() => {});
    }
  }

  private async record(
    attemptId: string,
    missionId: string,
    workspaceId: string,
    taskId: string,
    item: CheckItem,
  ) {
    await this.deps.db.transaction(async (tx) => {
      // Lock the attempt row so concurrent updates to its checklist serialise.
      await tx.execute(sql`select 1 from attempts where id = ${attemptId} for update`);
      const [row] = await tx
        .select({ checks: attempts.checks })
        .from(attempts)
        .where(eq(attempts.id, attemptId));
      const checks = row?.checks as AttemptChecks | undefined;
      if (!checks) return;
      checks.items = checks.items.map((i) => (i.index === item.index ? item : i));
      await tx
        .update(attempts)
        .set({ checks: checks as unknown as Record<string, unknown> })
        .where(eq(attempts.id, attemptId));
      await this.deps.events.append(tx, {
        workspaceId,
        missionId,
        taskId,
        attemptId,
        type: "check.result",
        actor: "system",
        payload: {
          index: item.index,
          kind: item.kind,
          command: item.command ?? null,
          passed: item.status === "passed",
          exitCode: item.exitCode ?? null,
          summary: item.summary ?? "",
          output: item.output ?? "",
          durationMs: item.durationMs ?? null,
        },
      });
    });
  }
}
