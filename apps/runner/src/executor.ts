// Executes one queued attempt in the cloud runner (ARCHITECTURE §4.3): claim it, do its work (attempt-work.ts) in a
// Docker sandbox with the credential revealed just in time, and record the result. Every step leaves an event; every
// spend a ledger entry.

import { join } from "node:path";
import { type AgentAdapter, adapterFor, type Dispatch, type FetchLike, type Logger } from "@brio/adapters";
import { type Db, type EventWriter, schema } from "@brio/db";
import type { Ledger } from "@brio/governance";
import type { Actor, EventType } from "@brio/schema";
import type { Redactor, Vault } from "@brio/vault";
import { and, eq, sql } from "drizzle-orm";
import {
  recordAttemptFinish,
  runAttemptWork,
  type WorkEnv,
  type WorkSink,
  ZERO_RESULT,
} from "./attempt-work";
import { ensureImage, type ImageSet } from "./images";
import { RunnerMailbox } from "./mailbox";
import { type MailboxMcpServer, SANDBOX_MAILBOX_URL } from "./mailbox-mcp";
import { DockerSandbox } from "./sandbox/docker-sandbox";
import { Worktrees } from "./worktree";

const { attempts, tasks } = schema;

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
  /** Serves the mailbox to CLI agents over MCP (through each sandbox's proxy). */
  mailboxServer?: MailboxMcpServer;
  /** How long ask_agent waits for an answer (default 3 minutes). */
  answerWaitMs?: number;
  /** Resolves adapter keys; defaults to the registered adapters (tests add fakes). */
  resolveAdapter?: (key: string) => AgentAdapter | undefined;
}

type AttemptRow = typeof attempts.$inferSelect;

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
      // Attempts for a local runner (M8) are never this runner's to take.
      .where(
        and(
          eq(attempts.id, attemptId),
          eq(attempts.status, "queued"),
          sql`(${attempts.dispatch} -> 'target') is null`,
        ),
      )
      .returning();
    return row ?? null;
  }

  async execute(attempt: AttemptRow, abort: AbortController): Promise<void> {
    const { deps } = this;
    const dispatch = attempt.dispatch as unknown as Dispatch | null;
    if (dispatch?.version !== 1) {
      await recordAttemptFinish(
        deps,
        attempt,
        null,
        ZERO_RESULT("the attempt has no dispatch plan"),
        null,
        null,
      );
      return;
    }
    if (dispatch.manageTask !== false)
      await deps.db.update(tasks).set({ status: "running" }).where(eq(tasks.id, attempt.taskId));
    const sink = dbSink(deps, attempt, dispatch);
    sink.event("attempt.started", startedPayload(dispatch, deps.runnerId), "system");

    const env: WorkEnv = {
      worktrees: this.worktrees,
      sandbox: async (i) =>
        DockerSandbox.create({
          attemptId: i.attemptId,
          runnerId: deps.runnerId,
          spec: i.spec,
          image: await ensureImage(deps.images, i.image),
          images: { ...deps.images, proxy: await ensureImage(deps.images, "proxy") },
          worktree: i.worktree,
          scratchDir: join(deps.dir, "scratch"),
          ...(deps.proxyAllowPrivate ? { proxyAllowPrivate: true } : {}),
          ...(i.mailboxPort ? { mailboxPort: i.mailboxPort } : {}),
        }),
      secret: async (ref) => (ref ? deps.vault.reveal(deps.db, attempt.workspaceId, ref) : null),
      fetch: deps.fetch,
      log: deps.log,
      redactor: deps.redactor,
      resolveAdapter: (key) => (deps.resolveAdapter ?? adapterFor)(key),
      mailbox: (research) => {
        const mailbox = new RunnerMailbox(
          deps.db,
          deps.events,
          {
            workspaceId: attempt.workspaceId,
            missionId: dispatch.missionId,
            taskId: attempt.taskId,
            taskKey: dispatch.taskKey,
            attemptId: attempt.id,
            agentId: dispatch.agent.agentId,
          },
          { answerWaitMs: deps.answerWaitMs ?? 180_000, signal: abort.signal },
        );
        // CLI agents reach the mailbox over MCP through their sandbox's proxy, with a token only this attempt holds.
        const server =
          dispatch.route === "cli" && dispatch.sandbox?.network.mode === "allowlist"
            ? deps.mailboxServer
            : undefined;
        const token = server?.register(mailbox, research) ?? null;
        if (token) deps.redactor.register(token);
        return {
          tools: mailbox,
          ...(server && token
            ? {
                cli: {
                  port: server.port,
                  server: {
                    name: "brio-mailbox",
                    transport: "http" as const,
                    url: SANDBOX_MAILBOX_URL,
                    headers: { Authorization: `Bearer ${token}` },
                  },
                },
              }
            : {}),
          release: () => {
            if (token) server?.revoke(token);
          },
        };
      },
    };
    const { result, worktree, collected } = await runAttemptWork(attempt, dispatch, env, sink, abort);
    await recordAttemptFinish(deps, attempt, dispatch, result, worktree, collected);
  }
}

/** What attempt.started says: who, how, where, within which limits. */
export function startedPayload(dispatch: Dispatch, runner: string): Record<string, unknown> {
  return {
    taskKey: dispatch.taskKey,
    agent: { id: dispatch.agent.agentId, name: dispatch.agent.name, model: dispatch.agent.model },
    adapter: dispatch.adapterKey,
    route: dispatch.route,
    runner,
    sandbox: dispatch.sandbox
      ? {
          profile: dispatch.sandbox.profile,
          network: dispatch.sandbox.network,
          cpus: dispatch.sandbox.cpus,
          memoryMb: dispatch.sandbox.memoryMb,
        }
      : null,
    limits: dispatch.input.limits,
  };
}

/** Events in order through the events writer; the attempt row learns its vendor run, branch and sandbox. */
export function dbSink(
  deps: { db: Db; events: EventWriter; log: Logger },
  attempt: { id: string; workspaceId: string; taskId: string },
  dispatch: Dispatch,
): WorkSink {
  const base = {
    workspaceId: attempt.workspaceId,
    missionId: dispatch.missionId,
    taskId: attempt.taskId,
    attemptId: attempt.id,
  };
  const agentActor: Actor = `agent:${dispatch.agent.agentId}`;
  let chain: Promise<unknown> = Promise.resolve();
  const then = (fn: () => Promise<unknown>, what: string) => {
    chain = chain
      .then(fn)
      .catch((err) =>
        deps.log.error({ err: (err as Error).message, attemptId: attempt.id, what }, "write failed"),
      );
  };
  return {
    event: (type: EventType, payload, actor = agentActor) =>
      then(() => deps.events.append(deps.db, { ...base, type, actor, payload }), type),
    vendorRun: (id) =>
      then(
        () => deps.db.update(attempts).set({ transcriptRef: id }).where(eq(attempts.id, attempt.id)),
        "vendor run",
      ),
    ready: async ({ branch, sandbox }) => {
      await deps.db
        .update(attempts)
        .set({ sandboxId: sandbox, worktreeRef: branch })
        .where(eq(attempts.id, attempt.id));
    },
    flush: async () => {
      await chain;
    },
  };
}
