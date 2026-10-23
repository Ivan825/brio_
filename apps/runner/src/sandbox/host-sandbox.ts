// The local runner's restricted mode (BUILD_PLAN M8): no container. An agent's CLI runs as the person, on their own
// machine, in a fresh git worktree that is not their working copy, with an environment cut down to what a CLI needs to
// find itself and its own sign-in (PATH, HOME, locale). Only with the person's explicit consent: there is no network
// allowlist and no CPU or memory cap here, only the wall clock. Brio never reads what the CLI stores in HOME.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import type { SandboxHandle, SandboxProcess } from "@brio/adapters";
import { confine, WORKDIR } from "./docker-sandbox";

/** What a CLI may see of the person's environment. */
const KEEP_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TZ",
];

export class HostSandbox implements SandboxHandle {
  readonly available = true;
  readonly name: string;
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  private killed = false;

  constructor(
    /** The worktree on the host; agents see it as /work. */
    readonly root: string,
    id: string,
    private readonly base: NodeJS.ProcessEnv = process.env,
  ) {
    this.name = `host-${id.slice(0, 12)}`;
  }

  /** A sandbox path (relative, or under /work) on the host, refusing anything outside the worktree. */
  private path(p: string): string {
    const inside = confine(
      p.startsWith(`${WORKDIR}/`) ? p.slice(WORKDIR.length + 1) : p === WORKDIR ? "." : p,
    );
    return join(this.root, inside === WORKDIR ? "" : inside.slice(WORKDIR.length + 1));
  }

  /** /work in an argument means the worktree here. */
  private arg(a: string): string {
    return a === WORKDIR
      ? this.root
      : a.startsWith(`${WORKDIR}/`)
        ? join(this.root, a.slice(WORKDIR.length + 1))
        : a;
  }

  private env(extra: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const k of KEEP_ENV) {
      const v = this.base[k];
      if (v) env[k] = v;
    }
    return { ...env, ...extra };
  }

  private start(argv: string[], env: Record<string, string>): ChildProcessWithoutNullStreams {
    const [cmd, ...rest] = argv.map((a) => this.arg(a));
    if (!cmd) throw new Error("nothing to run");
    // Its own process group, so a cancel stops everything the CLI started.
    const c = spawn(cmd, rest, {
      cwd: this.root,
      env: this.env(env),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.children.add(c);
    c.on("close", () => this.children.delete(c));
    c.stdin.on("error", () => {});
    return c;
  }

  async exec(command: string, opts: { timeoutMs?: number } = {}) {
    if (this.killed) return { exitCode: -1, stdout: "", stderr: "stopped" };
    const c = this.start(["sh", "-c", command], {});
    c.stdin.end();
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d: Buffer) => {
      stdout = (stdout + d.toString("utf8")).slice(-1024 * 1024);
    });
    c.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-256 * 1024);
    });
    const timer = setTimeout(() => killGroup(c), opts.timeoutMs ?? 120_000);
    const code = await new Promise<number | null>((r) => {
      c.on("close", (n) => r(n));
      c.on("error", (e) => {
        stderr += e.message;
        r(null);
      });
    });
    clearTimeout(timer);
    return { exitCode: code ?? -1, stdout, stderr };
  }

  async readFile(path: string): Promise<string> {
    return readFile(this.path(path), "utf8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    const target = this.path(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  async listFiles(path: string): Promise<string[]> {
    const start = this.path(path);
    const out: string[] = [];
    const walk = async (dir: string, depth: number) => {
      if (depth > 4 || out.length >= 2000) return;
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.name === ".git" || e.name === "node_modules") continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full, depth + 1);
        else if (e.isFile()) out.push(relative(this.root, full).split(sep).join("/"));
      }
    };
    await walk(start, 1);
    return out.slice(0, 2000);
  }

  spawn(
    argv: string[],
    opts: { env: Record<string, string>; stdin?: string; interactive?: boolean },
  ): SandboxProcess {
    let stderr = "";
    let c: ChildProcessWithoutNullStreams;
    try {
      c = this.start(argv, opts.env);
    } catch (e) {
      const message = (e as Error).message;
      return {
        lines: (async function* () {})(),
        exit: Promise.resolve({ code: null, stderr: message }),
        kill: async () => {},
      };
    }
    c.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-64 * 1024);
    });
    const exit = new Promise<{ code: number | null; stderr: string }>((r) => {
      c.on("close", (code) => r({ code, stderr }));
      c.on("error", (e) => r({ code: null, stderr: e.message }));
    });
    if (opts.interactive) {
      if (opts.stdin) c.stdin.write(opts.stdin);
    } else c.stdin.end(opts.stdin ?? "");
    const lines = (async function* () {
      const rl = createInterface({ input: c.stdout, crlfDelay: Number.POSITIVE_INFINITY });
      for await (const line of rl) yield line;
    })();
    return {
      lines,
      exit,
      kill: async () => killGroup(c),
      ...(opts.interactive
        ? { stdin: { write: (t: string) => void c.stdin.write(t), end: () => void c.stdin.end() } }
        : {}),
    };
  }

  /** Stops every process this sandbox started (cancel, limit). The worktree stays for the runner to collect. */
  async kill(): Promise<void> {
    this.killed = true;
    for (const c of this.children) killGroup(c);
  }

  async destroy(): Promise<void> {
    await this.kill();
  }
}

function killGroup(c: ChildProcessWithoutNullStreams) {
  if (c.pid === undefined || c.exitCode !== null) return;
  try {
    process.kill(-c.pid, "SIGTERM");
  } catch {
    c.kill("SIGTERM");
  }
  setTimeout(() => {
    try {
      if (c.pid !== undefined && c.exitCode === null) process.kill(-c.pid, "SIGKILL");
    } catch {}
  }, 3000).unref();
}
