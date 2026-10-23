// The local runner hub (BUILD_PLAN M8): local runners connect here over a WebSocket they open themselves. The hub hands
// each the work that is its own — queued attempts of agents bound to it, those attempts' command checks, merges and
// deliveries of projects that live on it — and records what comes back exactly as the cloud runner records its own
// work (recordAttemptFinish, recordCheck, recordMerge). Jobs are pulled from the database on connect, when someone
// pokes the runner (NOTIFY), and every few seconds; claims are atomic, so a reconnect never runs anything twice.
import { createHash } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { AttemptChecks, CheckItem, Dispatch } from "@brio/adapters";
import { schema } from "@brio/db";
import {
  CANCEL_CHANNEL,
  collectedFromWire,
  isCommand,
  mergeFromWire,
  PROTOCOL_VERSION,
  type RunnerMessage,
  recordAttemptFinish,
  recordCheck,
  recordMerge,
  resultFromWire,
  type ServerMessage,
  startedPayload,
  WEB_CHECKS,
} from "@brio/runner";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import pg from "pg";
import { type WebSocket, WebSocketServer } from "ws";
import type { AppContext } from "../context";

const { attempts, deliveries, integrations, missions, projects, runners, tasks } = schema;

export const RUNNER_TOKEN_PREFIX = "brio_rnr_";
export const RUNNER_JOBS_CHANNEL = "brio_runner_jobs";
export const runnerTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const CONNECT_PATH = "/v1/runners/connect";
/** Attempt outcomes carry diffs and produced files (base64). */
const MAX_MESSAGE = 128 * 1024 * 1024;

/** Asks whichever API instance holds the runner's connection to look for its work. */
export async function pokeRunner(db: AppContext["db"], runnerId: string): Promise<void> {
  await db.execute(sql`select pg_notify(${RUNNER_JOBS_CHANNEL}, ${runnerId})`);
}

interface InFlightAttempt {
  workspaceId: string;
  missionId: string;
  taskId: string;
  dispatch: Dispatch;
}

interface Connection {
  runnerId: string;
  workspaceId: string;
  name: string;
  ws: WebSocket;
  attempts: Map<string, InFlightAttempt>;
  checks: Set<string>;
  merges: Set<string>;
  deliveries: Set<string>;
  files: Map<string, (r: { files: string[]; error?: string }) => void>;
}

export class RunnerHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  private readonly connections = new Map<string, Connection>();
  private listener: pg.Client | null = null;
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;

  constructor(private readonly ctx: AppContext) {}

  /** Takes WebSocket upgrades for the runner endpoint on the API's HTTP server. */
  attach(server: Server): void {
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (new URL(req.url ?? "/", "http://x").pathname !== CONNECT_PATH) return;
      this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
    });
  }

  async start(): Promise<void> {
    this.listener = new pg.Client({ connectionString: this.ctx.config.DATABASE_URL });
    this.listener.on("error", (err) => this.ctx.log.warn({ err: err.message }, "runner hub listener error"));
    await this.listener.connect();
    this.listener.on("notification", (n) => {
      if (n.channel === RUNNER_JOBS_CHANNEL && n.payload) {
        const c = this.connections.get(n.payload);
        if (c) void this.pump(c);
      }
      if (n.channel === CANCEL_CHANNEL && n.payload)
        for (const c of this.connections.values())
          if (c.attempts.has(n.payload)) this.send(c, { t: "cancel", attemptId: n.payload });
    });
    await this.listener.query(`LISTEN ${RUNNER_JOBS_CHANNEL}`);
    await this.listener.query(`LISTEN ${CANCEL_CHANNEL}`);
    // Signs of life for the attempts a connected runner holds, picked-up cancels, and work nobody poked about.
    this.timers.push(
      setInterval(() => void this.heartbeat(), 5_000),
      setInterval(() => {
        for (const c of this.connections.values()) void this.pump(c);
      }, 10_000),
    );
    for (const t of this.timers) t.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    for (const c of this.connections.values()) c.ws.close(1001, "the API is stopping");
    this.wss.close();
    await this.listener?.end().catch(() => {});
  }

  /** Closes a runner's connection (it was revoked); its next hello is refused. */
  disconnect(runnerId: string): void {
    this.connections.get(runnerId)?.ws.close(4003, "revoked");
  }

  isOnline(runnerId: string): boolean {
    return this.connections.has(runnerId);
  }

  /** A repository's file list from the runner it lives on (for planning); null when that runner is not here. */
  async listFiles(
    runnerId: string,
    repo: { url: string; branch: string | null },
    timeoutMs = 20_000,
  ): Promise<{ files: string[]; error?: string } | null> {
    const c = this.connections.get(runnerId);
    if (!c) return null;
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        c.files.delete(requestId);
        resolve({ files: [], error: "the runner did not answer in time" });
      }, timeoutMs);
      c.files.set(requestId, (r) => {
        clearTimeout(timer);
        c.files.delete(requestId);
        resolve(r);
      });
      this.send(c, { t: "list_files", requestId, repo });
    });
  }

  private send(c: Connection, m: ServerMessage) {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(m));
  }

  /** The first message must be the runner's hello with its token, within ten seconds. */
  private accept(ws: WebSocket) {
    const timer = setTimeout(() => ws.close(4001, "say hello first"), 10_000);
    ws.once("message", (data) => {
      clearTimeout(timer);
      void this.hello(ws, String(data)).catch((err) => {
        ws.send(JSON.stringify({ t: "error", message: (err as Error).message } satisfies ServerMessage));
        ws.close(4003, "refused");
      });
    });
  }

  private async hello(ws: WebSocket, raw: string) {
    const m = JSON.parse(raw) as RunnerMessage;
    if (m.t !== "hello" || typeof m.token !== "string" || !m.token.startsWith(RUNNER_TOKEN_PREFIX))
      throw new Error("not a runner token: run `brio runner register` again");
    if (m.protocol !== PROTOCOL_VERSION)
      throw new Error(
        `this runner speaks protocol ${m.protocol}; Brio speaks ${PROTOCOL_VERSION}: update brio`,
      );
    const [r] = await this.ctx.db
      .update(runners)
      .set({ lastSeenAt: new Date(), capabilities: m.capabilities })
      .where(and(eq(runners.tokenHash, runnerTokenHash(m.token)), isNull(runners.revokedAt)))
      .returning();
    if (!r) throw new Error("this runner token is unknown or revoked: run `brio runner register` again");
    // One connection per runner: a new one replaces an old one (a restart, a network change).
    this.connections.get(r.id)?.ws.close(4000, "replaced by a new connection");
    const c: Connection = {
      runnerId: r.id,
      workspaceId: r.workspaceId,
      name: r.name,
      ws,
      attempts: new Map(),
      checks: new Set(),
      merges: new Set(),
      deliveries: new Set(),
      files: new Map(),
    };
    this.connections.set(r.id, c);
    ws.on("message", (data) => {
      let msg: RunnerMessage;
      try {
        msg = JSON.parse(String(data)) as RunnerMessage;
      } catch {
        return;
      }
      void this.receive(c, msg).catch((err) =>
        this.ctx.log.error(
          { err: (err as Error).message, runner: c.runnerId, t: msg.t },
          "runner message failed",
        ),
      );
    });
    ws.on("close", () => {
      if (this.connections.get(c.runnerId) === c) this.connections.delete(c.runnerId);
      for (const done of c.files.values()) done({ files: [], error: "the runner went away" });
    });
    this.send(c, { t: "welcome", runnerId: r.id, name: r.name, mode: r.mode as "docker" | "host" });
    this.ctx.log.info({ runner: r.id, name: r.name, mode: r.mode }, "local runner connected");
    await this.pump(c);
  }

  private async heartbeat() {
    for (const c of this.connections.values()) {
      const ids = [...c.attempts.keys()];
      if (!ids.length) continue;
      const rows = await this.ctx.db
        .update(attempts)
        .set({ heartbeatAt: new Date() })
        .where(and(inArray(attempts.id, ids), eq(attempts.runnerId, `local:${c.runnerId}`)))
        .returning({ id: attempts.id, cancel: attempts.cancelRequestedAt })
        .catch(() => []);
      for (const r of rows) if (r.cancel) this.send(c, { t: "cancel", attemptId: r.id });
      await this.ctx.db
        .update(runners)
        .set({ lastSeenAt: new Date() })
        .where(eq(runners.id, c.runnerId))
        .catch(() => {});
    }
  }

  /** Hands the runner everything that is its own and not yet handed. */
  private async pump(c: Connection): Promise<void> {
    if (this.stopped || this.connections.get(c.runnerId) !== c) return;
    const { db } = this.ctx;
    const local = sql`${attempts.dispatch} -> 'target' ->> 'runnerId' = ${c.runnerId}`;

    // Queued attempts: claimed here, started there.
    const queued = await db
      .select()
      .from(attempts)
      .where(and(eq(attempts.status, "queued"), local))
      .orderBy(asc(attempts.createdAt));
    for (const a of queued) {
      const [row] = await db
        .update(attempts)
        .set({
          status: "running",
          runnerId: `local:${c.runnerId}`,
          startedAt: new Date(),
          heartbeatAt: new Date(),
        })
        .where(and(eq(attempts.id, a.id), eq(attempts.status, "queued")))
        .returning();
      if (!row) continue;
      const dispatch = row.dispatch as unknown as Dispatch;
      if (dispatch.manageTask !== false)
        await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, row.taskId));
      await this.ctx.events.append(db, {
        workspaceId: row.workspaceId,
        missionId: dispatch.missionId,
        taskId: row.taskId,
        attemptId: row.id,
        type: "attempt.started",
        actor: "system",
        payload: startedPayload(dispatch, `local runner ${c.name}`),
      });
      c.attempts.set(row.id, {
        workspaceId: row.workspaceId,
        missionId: dispatch.missionId,
        taskId: row.taskId,
        dispatch,
      });
      this.send(c, {
        t: "attempt",
        attempt: { id: row.id, workspaceId: row.workspaceId, taskId: row.taskId },
        dispatch,
      });
    }

    // Command checks of its finished attempts (link and source checks stay with the cloud runner).
    const done = await db
      .select({ a: attempts, missionId: tasks.missionId })
      .from(attempts)
      .innerJoin(tasks, eq(tasks.id, attempts.taskId))
      .where(and(eq(attempts.status, "succeeded"), local, sql`${attempts.checks} is not null`));
    for (const { a, missionId } of done) {
      if (c.checks.has(a.id)) continue;
      const items = ((a.checks as AttemptChecks | null)?.items ?? []).filter(
        (i) => i.status === "pending" && (isCommand(i) || WEB_CHECKS.has(i.kind)),
      );
      if (!items.length) continue;
      const dispatch = a.dispatch as unknown as Dispatch;
      const ids = { attemptId: a.id, missionId, workspaceId: a.workspaceId, taskId: a.taskId };
      if (!a.worktreeRef) {
        for (const item of items)
          await recordCheck(this.ctx, ids, {
            ...item,
            status: "failed",
            summary: `${item.kind} needs files to check; this task produced none`,
          });
        continue;
      }
      c.checks.add(a.id);
      this.send(c, {
        t: "checks",
        attemptId: a.id,
        missionId,
        taskKey: dispatch.taskKey,
        branch: a.worktreeRef,
        repo: dispatch.repo ? { url: dispatch.repo.url, branch: dispatch.repo.branch } : null,
        items,
      });
    }

    // Merges and deliveries of the projects that live on this runner.
    const onRunner = sql`${missions.projectId} in (select ${projects.id} from ${projects} where ${projects.runnerId} = ${c.runnerId})`;
    const rounds = await db
      .select({ i: integrations })
      .from(integrations)
      .innerJoin(missions, eq(missions.id, integrations.missionId))
      .where(and(eq(integrations.status, "queued"), onRunner));
    for (const { i } of rounds) {
      const [row] = await db
        .update(integrations)
        .set({ status: "running" })
        .where(and(eq(integrations.id, i.id), eq(integrations.status, "queued")))
        .returning();
      if (!row) continue;
      c.merges.add(row.id);
      this.send(c, {
        t: "merge",
        row: {
          id: row.id,
          missionId: row.missionId,
          planVersion: row.planVersion,
          round: row.round,
          refs: row.refs,
          repo: row.repo,
        },
        commands: row.commands,
      });
    }
    const waiting = await db
      .select({ d: deliveries })
      .from(deliveries)
      .innerJoin(missions, eq(missions.id, deliveries.missionId))
      .where(and(eq(deliveries.status, "queued"), onRunner));
    for (const { d } of waiting) {
      const [row] = await db
        .update(deliveries)
        .set({ status: "running", error: null })
        .where(and(eq(deliveries.id, d.id), eq(deliveries.status, "queued")))
        .returning();
      if (!row) continue;
      c.deliveries.add(row.id);
      await this.ctx.events.append(db, {
        workspaceId: row.workspaceId,
        missionId: row.missionId,
        type: "delivery.started",
        actor: "system",
        payload: {
          deliveryId: row.id,
          kind: row.kind,
          branch: row.branch,
          commit: row.commit,
          runner: c.name,
        },
      });
      this.send(c, {
        t: "deliver",
        deliveryId: row.id,
        repo: row.repo.url,
        branch: row.branch,
        commit: row.commit,
      });
    }
  }

  /** One message from a runner: only about work this connection holds. */
  private async receive(c: Connection, m: RunnerMessage): Promise<void> {
    const { db } = this.ctx;
    switch (m.t) {
      case "event": {
        const a = c.attempts.get(m.attemptId);
        if (!a) return;
        await this.ctx.events.append(db, {
          workspaceId: a.workspaceId,
          missionId: a.missionId,
          taskId: a.taskId,
          attemptId: m.attemptId,
          type: m.type,
          actor: m.actor ?? `agent:${a.dispatch.agent.agentId}`,
          payload: m.payload,
        });
        return;
      }
      case "vendor_run":
        if (c.attempts.has(m.attemptId))
          await db.update(attempts).set({ transcriptRef: m.id }).where(eq(attempts.id, m.attemptId));
        return;
      case "ready":
        if (c.attempts.has(m.attemptId))
          await db
            .update(attempts)
            .set({ sandboxId: `${c.name}:${m.sandbox}`, worktreeRef: m.branch })
            .where(eq(attempts.id, m.attemptId));
        return;
      case "attempt_done": {
        const a = c.attempts.get(m.attemptId);
        if (!a) return;
        c.attempts.delete(m.attemptId);
        // Only while it is still this runner's (the reaper may have given up on it during a long disconnect).
        const [still] = await db
          .select({ id: attempts.id })
          .from(attempts)
          .where(
            and(
              eq(attempts.id, m.attemptId),
              eq(attempts.status, "running"),
              eq(attempts.runnerId, `local:${c.runnerId}`),
            ),
          );
        if (!still) return;
        await recordAttemptFinish(
          {
            db,
            events: this.ctx.events,
            ledger: this.ctx.ledger,
            redactor: this.ctx.redactor,
            log: this.logger(),
          },
          { id: m.attemptId, workspaceId: a.workspaceId, taskId: a.taskId },
          a.dispatch,
          resultFromWire(m.result),
          m.worktree,
          m.collected ? collectedFromWire(m.collected) : null,
        );
        return;
      }
      case "check_result": {
        if (!c.checks.has(m.attemptId)) return;
        const [row] = await db
          .select({ a: attempts, missionId: tasks.missionId })
          .from(attempts)
          .innerJoin(tasks, eq(tasks.id, attempts.taskId))
          .where(eq(attempts.id, m.attemptId));
        if (!row) return;
        const current = ((row.a.checks as AttemptChecks | null)?.items ?? []).find(
          (i) => i.index === m.item.index,
        );
        // A local runner may settle only its own kinds of check, and only once.
        if (!current || current.status !== "pending" || current.kind !== m.item.kind) return;
        const item: CheckItem = { ...m.item, output: this.ctx.redactor.redact(m.item.output ?? "") };
        await recordCheck(
          this.ctx,
          {
            attemptId: m.attemptId,
            missionId: row.missionId,
            workspaceId: row.a.workspaceId,
            taskId: row.a.taskId,
          },
          item,
        );
        return;
      }
      case "checks_done":
        c.checks.delete(m.attemptId);
        return;
      case "merge_done": {
        if (!c.merges.delete(m.integrationId)) return;
        const [row] = await db.select().from(integrations).where(eq(integrations.id, m.integrationId));
        if (!row || row.status !== "running") return;
        await recordMerge(this.ctx, row, mergeFromWire(m.outcome));
        return;
      }
      case "delivery_done": {
        if (!c.deliveries.delete(m.deliveryId)) return;
        const [d] = await db
          .update(deliveries)
          .set(m.ok ? { status: "done" } : { status: "failed", error: m.error ?? "the push failed" })
          .where(and(eq(deliveries.id, m.deliveryId), eq(deliveries.status, "running")))
          .returning();
        if (!d) return;
        if (m.ok)
          await this.ctx.ledger.append(db, {
            workspaceId: d.workspaceId,
            kind: "side_effect",
            payload: {
              action: "git.push",
              deliveryId: d.id,
              missionId: d.missionId,
              repo: d.repo.url,
              branch: d.branch,
              commit: d.commit,
              runner: c.runnerId,
            },
          });
        await this.ctx.events.append(db, {
          workspaceId: d.workspaceId,
          missionId: d.missionId,
          type: m.ok ? "delivery.done" : "delivery.failed",
          actor: "system",
          payload: { deliveryId: d.id, kind: d.kind, branch: d.branch, ...(m.ok ? {} : { error: d.error }) },
        });
        return;
      }
      case "files":
        c.files.get(m.requestId)?.({ files: m.files, ...(m.error ? { error: m.error } : {}) });
        return;
      case "hello":
        return;
    }
  }

  private logger() {
    const log = this.ctx.log;
    return {
      debug: (o: Record<string, unknown> | string, msg?: string) => log.debug(o as object, msg),
      info: (o: Record<string, unknown> | string, msg?: string) => log.info(o as object, msg),
      warn: (o: Record<string, unknown> | string, msg?: string) => log.warn(o as object, msg),
      error: (o: Record<string, unknown> | string, msg?: string) => log.error(o as object, msg),
    };
  }
}
