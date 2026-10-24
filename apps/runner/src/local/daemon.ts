// `brio runner` (BUILD_PLAN M8): the local runner daemon on the person's machine. It opens one WebSocket to the API,
// says what it can run, and does the work the API sends — attempts of the agents bound to it, their command checks,
// merges and deliveries of the projects that live on it — in Docker or, with its owner's consent, on the host. It
// keeps no database: events and outcomes go back over the socket. Agents' API keys never come here (they stay in the
// vault); CLIs run under the person's own sign-in, which the runner never reads.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type AgentAdapter,
  adapterFor,
  type CheckItem,
  type FetchLike,
  guardedFetch,
  LimitExceeded,
  type Logger,
} from "@brio/adapters";
import { Redactor } from "@brio/vault";
import { runAttemptWork, type WorkSandbox } from "../attempt-work";
import { CHECK_SANDBOX, isCommand, runCommandCheck } from "../checks";
import { ensureImage, type ImageSet } from "../images";
import { mergeWork } from "../integrate";
import { DockerSandbox } from "../sandbox/docker-sandbox";
import { HostSandbox } from "../sandbox/host-sandbox";
import { Worktrees } from "../worktree";
import {
  collectedToWire,
  mergeToWire,
  PROTOCOL_VERSION,
  RUNNER_SUBPROTOCOL,
  type RunnerCapabilities,
  type RunnerMessage,
  resultToWire,
  type ServerMessage,
} from "./protocol";

const run = promisify(execFile);

export const RUNNER_VERSION = "0.8.0";

/** CLIs a runner looks for, by adapter key and binary. */
const KNOWN_CLIS: Array<[string, string]> = [
  ["claude-code", "claude"],
  ["antigravity", "agy"],
  ["codex", "codex"],
  ["cursor-agent", "cursor-agent"],
  ["opencode", "opencode"],
  ["goose", "goose"],
  ["aider", "aider"],
];

/** What is installed here: each known CLI's version, and whether Docker answers. */
export async function detectCapabilities(env: NodeJS.ProcessEnv = process.env): Promise<RunnerCapabilities> {
  const clis: RunnerCapabilities["clis"] = [];
  await Promise.all(
    KNOWN_CLIS.map(async ([key, bin]) => {
      try {
        const { stdout } = await run(bin, ["--version"], { timeout: 5000, env });
        clis.push({ key, version: stdout.trim().split("\n")[0]?.slice(0, 80) ?? "" });
      } catch {}
    }),
  );
  let docker = false;
  try {
    await run("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 5000, env });
    docker = true;
  } catch {}
  clis.sort((a, b) => a.key.localeCompare(b.key));
  return { clis, docker, os: `${process.platform}-${process.arch}`, version: RUNNER_VERSION };
}

export interface LocalRunnerOptions {
  /** The Brio web app or API origin, e.g. https://brio.example. */
  url: string;
  /** The runner token from `brio runner register`. */
  token: string;
  /** Worktrees, repository caches and scratch files. */
  dir: string;
  log: Logger;
  images?: ImageSet;
  fetch?: FetchLike;
  /** The environment host-mode CLIs see a cut-down copy of. */
  env?: NodeJS.ProcessEnv;
  concurrency?: number;
  reconnectMs?: number;
  capabilities?: RunnerCapabilities;
  resolveAdapter?: (key: string) => AgentAdapter | undefined;
  WebSocket?: typeof WebSocket;
}

export class LocalRunner {
  private ws: WebSocket | null = null;
  private stopped = false;
  private mode: "docker" | "host" = "docker";
  private readonly worktrees: Worktrees;
  private readonly redactor = new Redactor();
  private readonly running = new Map<string, AbortController>();
  private readonly queue: Array<() => Promise<void>> = [];
  private active = 0;
  runnerId: string | null = null;

  constructor(private readonly o: LocalRunnerOptions) {
    this.worktrees = new Worktrees(o.dir);
  }

  private wsUrl(): string {
    const u = new URL("/v1/runners/connect", this.o.url);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.toString();
  }

  /** Connects and stays connected (reconnecting with backoff) until stop(); resolves once the API has welcomed it. */
  async start(): Promise<void> {
    const capabilities = this.o.capabilities ?? (await detectCapabilities(this.o.env));
    let welcomed: () => void = () => {};
    let refused: (e: Error) => void = () => {};
    const first = new Promise<void>((res, rej) => {
      welcomed = res;
      refused = rej;
    });
    let delay = this.o.reconnectMs ?? 1000;
    const connect = () => {
      if (this.stopped) return;
      const Impl = this.o.WebSocket ?? WebSocket;
      // The token goes in the handshake (as a subprotocol: a browser-style WebSocket sends no headers), so the API
      // accepts no socket from anyone without one; hello repeats it.
      const ws = new Impl(this.wsUrl(), [RUNNER_SUBPROTOCOL, this.o.token]);
      this.ws = ws;
      ws.addEventListener("open", () => {
        this.send({ t: "hello", token: this.o.token, protocol: PROTOCOL_VERSION, capabilities });
      });
      ws.addEventListener("message", (ev) => {
        let m: ServerMessage;
        try {
          m = JSON.parse(String(ev.data)) as ServerMessage;
        } catch {
          return;
        }
        if (m.t === "welcome") {
          this.runnerId = m.runnerId;
          this.mode = m.mode;
          delay = this.o.reconnectMs ?? 1000;
          this.o.log.info({ runner: m.name, mode: m.mode }, "connected to Brio");
          welcomed();
          return;
        }
        if (m.t === "error") {
          this.o.log.error({ err: m.message }, "Brio refused the runner");
          refused(new Error(m.message));
          this.stopped = true;
          ws.close();
          return;
        }
        this.handle(m);
      });
      ws.addEventListener("close", () => {
        if (this.ws === ws) this.ws = null;
        if (this.stopped) return;
        setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30_000);
      });
      ws.addEventListener("error", () => {});
    };
    connect();
    await first;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const a of this.running.values()) a.abort();
    this.ws?.close();
  }

  private send(m: RunnerMessage) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  /** Jobs run a few at a time; cancels and file lists answer at once. */
  private handle(m: ServerMessage) {
    switch (m.t) {
      case "cancel":
        this.running
          .get(m.attemptId)
          ?.abort(m.reason?.startsWith("budget") ? new LimitExceeded(m.reason) : undefined);
        return;
      case "list_files":
        void this.listFiles(m);
        return;
      case "attempt":
      case "checks":
      case "merge":
      case "deliver":
        this.queue.push(() => this.job(m));
        this.drain();
        return;
    }
  }

  private drain() {
    while (this.active < (this.o.concurrency ?? 2) && this.queue.length) {
      const next = this.queue.shift() as () => Promise<void>;
      this.active++;
      void next()
        .catch((err) => this.o.log.error({ err: (err as Error).message }, "local job failed"))
        .finally(() => {
          this.active--;
          this.drain();
        });
    }
  }

  private async job(m: Extract<ServerMessage, { t: "attempt" | "checks" | "merge" | "deliver" }>) {
    if (m.t === "attempt") return this.attempt(m);
    if (m.t === "checks") return this.checks(m);
    if (m.t === "merge") return this.merge(m);
    return this.deliver(m);
  }

  /** A sandbox on a worktree: a container, or (restricted mode) the host. */
  private async sandbox(
    id: string,
    worktree: string,
    spec: Parameters<typeof DockerSandbox.create>[0]["spec"],
    image: "base" | "cli" | "browser" | "web",
  ): Promise<WorkSandbox> {
    if (this.mode === "host") return new HostSandbox(worktree, id, this.o.env ?? process.env);
    const images = this.o.images;
    if (!images) throw new Error("this runner has no sandbox images configured");
    return DockerSandbox.create({
      attemptId: id,
      runnerId: `local-${this.runnerId ?? "runner"}`,
      spec,
      image: await ensureImage(images, image),
      images: { ...images, proxy: await ensureImage(images, "proxy") },
      worktree,
      scratchDir: join(this.o.dir, "scratch"),
    });
  }

  private async attempt(m: Extract<ServerMessage, { t: "attempt" }>) {
    const abort = new AbortController();
    this.running.set(m.attempt.id, abort);
    const attemptId = m.attempt.id;
    try {
      const outcome = await runAttemptWork(
        m.attempt,
        m.dispatch,
        {
          worktrees: this.worktrees,
          sandbox: (i) => this.sandbox(i.attemptId, i.worktree, i.spec, i.image),
          secret: async (ref) => {
            if (!ref) return null;
            throw new Error(
              "this agent's key stays in Brio's vault: a local runner runs CLIs under the person's own sign-in",
            );
          },
          // The person's own network is theirs to reach (local models); cloud metadata and link-local never.
          fetch: this.o.fetch ?? guardedFetch(fetch, { allowPrivate: true, allowHttp: true }),
          log: this.o.log,
          redactor: this.redactor,
          resolveAdapter: (key) => (this.o.resolveAdapter ?? adapterFor)(key),
        },
        {
          event: (type, payload, actor) =>
            this.send({ t: "event", attemptId, type, payload, ...(actor ? { actor } : {}) }),
          vendorRun: (id) => this.send({ t: "vendor_run", attemptId, id }),
          ready: async ({ branch, sandbox }) => this.send({ t: "ready", attemptId, branch, sandbox }),
          flush: async () => {},
        },
        abort,
      );
      this.send({
        t: "attempt_done",
        attemptId,
        result: resultToWire(outcome.result),
        worktree: outcome.worktree ? { branch: outcome.worktree.branch, base: outcome.worktree.base } : null,
        collected: outcome.collected ? collectedToWire(outcome.collected) : null,
      });
    } finally {
      this.running.delete(attemptId);
    }
  }

  /** The attempt's command checks, on its branch in a fresh worktree; web audits stay in Brio's cloud sandboxes. */
  private async checks(m: Extract<ServerMessage, { t: "checks" }>) {
    const result = (item: CheckItem) => this.send({ t: "check_result", attemptId: m.attemptId, item });
    let worktree: Awaited<ReturnType<Worktrees["prepare"]>> | null = null;
    let sandbox: WorkSandbox | null = null;
    try {
      const cache = await this.worktrees.cache(m.repo ? { repo: m.repo } : { missionId: m.missionId }, {
        fetch: false,
      });
      worktree = await this.worktrees.prepare({
        attemptId: `check-${m.attemptId}`,
        missionId: m.missionId,
        taskKey: `${m.taskKey}-checks`,
        bases: [m.branch],
        cacheOverride: cache,
      });
      for (const item of m.items) {
        if (!isCommand(item)) {
          result({
            ...item,
            status: "failed",
            summary: `${item.kind} audits run in Brio's cloud sandboxes, not on a local runner`,
          });
          continue;
        }
        sandbox ??= await this.sandbox(`check-${m.attemptId}`, worktree.path, CHECK_SANDBOX, "base");
        result(await runCommandCheck(sandbox, item, this.redactor));
      }
    } catch (err) {
      const message = this.redactor.redact((err as Error).message);
      for (const item of m.items)
        result({ ...item, status: "failed", summary: `could not run the check: ${message}` });
    } finally {
      await sandbox?.destroy().catch(() => {});
      if (worktree) await this.worktrees.remove(worktree).catch(() => {});
      this.send({ t: "checks_done", attemptId: m.attemptId });
    }
  }

  private async merge(m: Extract<ServerMessage, { t: "merge" }>) {
    const outcome = await mergeWork(
      {
        worktrees: this.worktrees,
        redactor: this.redactor,
        sandbox: (i) => this.sandbox(i.id, i.worktree, CHECK_SANDBOX, "base"),
      },
      m.row,
      m.commands,
    );
    this.send({ t: "merge_done", integrationId: m.row.id, outcome: mergeToWire(outcome) });
  }

  /** Pushes the mission's integrated commit into the person's repository as a new branch (never their checkout). */
  private async deliver(m: Extract<ServerMessage, { t: "deliver" }>) {
    try {
      const cache = await this.worktrees.cache({ repo: { url: m.repo } }, { fetch: false });
      await this.worktrees.git(["--git-dir", cache, "cat-file", "-e", `${m.commit}^{commit}`]).catch(() => {
        throw new Error("the integration commit is not on this runner");
      });
      await this.worktrees.git([
        "--git-dir",
        cache,
        "push",
        "-q",
        "--",
        m.repo,
        `${m.commit}:refs/heads/${m.branch}`,
      ]);
      this.send({ t: "delivery_done", deliveryId: m.deliveryId, ok: true });
    } catch (err) {
      this.send({
        t: "delivery_done",
        deliveryId: m.deliveryId,
        ok: false,
        error: this.redactor.redact((err as Error).message).slice(0, 1000),
      });
    }
  }

  /** The repository's file list, for planning a mission on it. */
  private async listFiles(m: Extract<ServerMessage, { t: "list_files" }>) {
    try {
      const cache = await this.worktrees.cache({ repo: m.repo });
      const ref = m.repo.branch ? `refs/heads/${m.repo.branch}` : "HEAD";
      this.send({ t: "files", requestId: m.requestId, files: await this.worktrees.listFiles(cache, ref) });
    } catch (err) {
      this.send({ t: "files", requestId: m.requestId, files: [], error: (err as Error).message });
    }
  }
}
