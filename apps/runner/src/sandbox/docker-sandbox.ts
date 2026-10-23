// One container per attempt (ARCHITECTURE §4.3, SECURITY_GOVERNANCE §3): non-root, read-only root filesystem, writable
// worktree and tmp only, no capabilities, CPU/memory/PID limits, no Docker socket. Network is either none, or an
// internal Docker network whose only way out is a per-attempt egress proxy that forwards to allow-listed hosts.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { createInterface } from "node:readline";
import type { SandboxHandle, SandboxProcess } from "@brio/adapters";
import type { SandboxSpec } from "@brio/core";
import { DockerError, docker } from "../docker";

export const WORKDIR = "/work";
const PROXY_PORT = 3128;

export interface SandboxImages {
  proxy: string;
}

export interface CreateSandboxInput {
  attemptId: string;
  runnerId: string;
  spec: SandboxSpec;
  image: string;
  images: SandboxImages;
  /** Host path of the attempt's worktree, bind-mounted at /work. */
  worktree: string;
  /** Where the runner keeps short-lived files (env files for docker exec). */
  scratchDir: string;
  /** Lets the proxy reach private addresses (tests with a local upstream only). */
  proxyAllowPrivate?: boolean;
  /** Port of the runner's mailbox server; the proxy relays brio-mailbox:8080 to it. */
  mailboxPort?: number;
}

/** A relative path inside the worktree, or an error. Absolute paths and `..` escapes are refused. */
export function confine(path: string): string {
  if (!path || path.includes("\0")) throw new Error("a path is required");
  const normal = posix.normalize(path.replaceAll("\\", "/"));
  if (normal.startsWith("/") || normal === ".." || normal.startsWith("../"))
    throw new Error(`${path} is outside the working directory`);
  return normal === "." ? WORKDIR : posix.join(WORKDIR, normal);
}

const hostUser = () => {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  // Never run sandboxes as root, even when the runner is.
  return uid === 0 ? "1000:1000" : `${uid}:${gid}`;
};

export class DockerSandbox implements SandboxHandle {
  readonly available = true;
  private killed = false;

  private constructor(
    readonly name: string,
    private readonly network: string | null,
    private readonly proxy: string | null,
    private readonly scratchDir: string,
  ) {}

  static async create(i: CreateSandboxInput): Promise<DockerSandbox> {
    const short = i.attemptId.replaceAll("-", "").slice(-12);
    const labels = ["--label", `brio.attempt=${i.attemptId}`, "--label", `brio.runner=${i.runnerId}`];
    const name = `brio-sbx-${short}`;
    let network: string | null = null;
    let proxy: string | null = null;
    const netArgs: string[] = [];
    const proxyEnv: string[] = [];
    await mkdir(i.scratchDir, { recursive: true, mode: 0o700 });

    try {
      if (i.spec.network.mode === "none") netArgs.push("--network", "none");
      else {
        network = `brio-net-${short}`;
        proxy = `brio-px-${short}`;
        await docker(["network", "create", "--internal", ...labels, network]);
        await docker([
          "run",
          "-d",
          "--name",
          proxy,
          ...labels,
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--pids-limit",
          "64",
          "--memory",
          "128m",
          "-e",
          `BRIO_PROXY_ALLOW=${i.spec.network.hosts.join(",")}`,
          "-e",
          `BRIO_PROXY_ALLOW_PRIVATE=${i.proxyAllowPrivate ? "true" : "false"}`,
          ...(i.mailboxPort
            ? [
                "-e",
                `BRIO_PROXY_MAILBOX_UPSTREAM=host.docker.internal:${i.mailboxPort}`,
                "--add-host",
                "host.docker.internal:host-gateway",
              ]
            : []),
          i.images.proxy,
        ]);
        await docker(["network", "connect", "--alias", "egress", "--alias", "brio-mailbox", network, proxy]);
        await waitForProxy(proxy);
        netArgs.push("--network", network);
        const url = `http://egress:${PROXY_PORT}`;
        for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"])
          proxyEnv.push("-e", `${k}=${url}`);
        proxyEnv.push("-e", "NO_PROXY=localhost,127.0.0.1", "-e", "no_proxy=localhost,127.0.0.1");
      }

      const mount = `${i.worktree}:${WORKDIR}${i.spec.worktree === "ro" ? ":ro" : ""}`;
      await docker([
        "run",
        "-d",
        "--init",
        "--name",
        name,
        ...labels,
        "--user",
        hostUser(),
        "--read-only",
        "--tmpfs",
        "/tmp:rw,exec,size=1g",
        "--mount",
        "type=tmpfs,destination=/home/brio,tmpfs-mode=1777,tmpfs-size=1073741824",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        String(i.spec.pids),
        "--cpus",
        String(i.spec.cpus),
        "--memory",
        `${i.spec.memoryMb}m`,
        "--memory-swap",
        `${i.spec.memoryMb}m`,
        ...netArgs,
        ...proxyEnv,
        ...(i.spec.worktree === "none" ? [] : ["-v", mount]),
        "-w",
        WORKDIR,
        i.image,
        "sleep",
        "infinity",
      ]);
    } catch (e) {
      await teardown([name, proxy], network);
      throw e;
    }
    return new DockerSandbox(name, network, proxy, i.scratchDir);
  }

  async exec(command: string, opts: { timeoutMs?: number } = {}) {
    const r = await docker(["exec", "-w", WORKDIR, this.name, "sh", "-c", command], {
      allowFail: true,
      timeoutMs: opts.timeoutMs ?? 120_000,
    });
    return { exitCode: r.code ?? -1, stdout: r.stdout, stderr: r.stderr };
  }

  async readFile(path: string): Promise<string> {
    const r = await docker(["exec", this.name, "cat", "--", confine(path)], {
      allowFail: true,
      timeoutMs: 30_000,
    });
    if (r.code !== 0) throw new Error(r.stderr.trim() || `cannot read ${path}`);
    return r.stdout;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const target = confine(path);
    const r = await docker(
      ["exec", "-i", this.name, "sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", target],
      { input: content, allowFail: true, timeoutMs: 30_000 },
    );
    if (r.code !== 0) throw new Error(r.stderr.trim() || `cannot write ${path}`);
  }

  async listFiles(path: string): Promise<string[]> {
    const root = confine(path);
    const r = await docker(
      [
        "exec",
        this.name,
        "find",
        root,
        "-maxdepth",
        "4",
        "-not",
        "-path",
        "*/.git/*",
        "-not",
        "-path",
        "*/node_modules/*",
        "-type",
        "f",
      ],
      { allowFail: true, timeoutMs: 30_000 },
    );
    if (r.code !== 0) throw new Error(r.stderr.trim() || `cannot list ${path}`);
    return r.stdout
      .split("\n")
      .filter(Boolean)
      .slice(0, 2000)
      .map((f) => posix.relative(WORKDIR, f));
  }

  spawn(argv: string[], opts: { env: Record<string, string>; stdin?: string }): SandboxProcess {
    // Secrets go through a 0600 env file read once by the docker CLI, never through argv (visible in `ps`).
    const envFile = join(this.scratchDir, `env-${randomBytes(8).toString("hex")}`);
    const envText = Object.entries(opts.env)
      .map(([k, v]) => `${k}=${v.replaceAll("\n", " ")}`)
      .join("\n");
    let stderr = "";
    let resolveExit!: (v: { code: number | null; stderr: string }) => void;
    const exit = new Promise<{ code: number | null; stderr: string }>((r) => {
      resolveExit = r;
    });
    // Starts at once; stdout is read through `lines`.
    const child = writeFile(envFile, `${envText}\n`, { mode: 0o600 }).then(() => {
      const c = spawn("docker", ["exec", "-i", "--env-file", envFile, "-w", WORKDIR, this.name, ...argv], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      c.stderr.on("data", (d: Buffer) => {
        stderr = (stderr + d.toString("utf8")).slice(-64 * 1024);
      });
      c.on("close", (code) => {
        void rm(envFile, { force: true });
        resolveExit({ code, stderr });
      });
      c.on("error", (e) => {
        void rm(envFile, { force: true });
        resolveExit({ code: null, stderr: e.message });
      });
      c.stdin.on("error", () => {});
      c.stdin.end(opts.stdin ?? "");
      return c;
    });
    child.catch((e: Error) => resolveExit({ code: null, stderr: e.message }));
    const lines = (async function* () {
      const c = await child;
      const rl = createInterface({ input: c.stdout, crlfDelay: Number.POSITIVE_INFINITY });
      for await (const line of rl) yield line;
    })();
    return { lines, exit, kill: () => this.kill() };
  }

  /** Stops everything in the sandbox at once (cancel, limit breach). The worktree stays on the host. */
  async kill(): Promise<void> {
    if (this.killed) return;
    this.killed = true;
    await docker(["kill", this.name], { allowFail: true, timeoutMs: 10_000 });
  }

  async destroy(): Promise<void> {
    await teardown([this.name, this.proxy], this.network);
  }
}

async function waitForProxy(proxy: string) {
  for (let i = 0; i < 50; i++) {
    const r = await docker(["exec", proxy, "wget", "-qO-", `http://127.0.0.1:${PROXY_PORT}/__health`], {
      allowFail: true,
      timeoutMs: 5000,
    });
    if (r.code === 0) return;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new DockerError("the egress proxy did not start", null, "");
}

async function teardown(containers: (string | null)[], network: string | null) {
  const names = containers.filter((c): c is string => Boolean(c));
  if (names.length) await docker(["rm", "-f", ...names], { allowFail: true });
  if (network) await docker(["network", "rm", network], { allowFail: true });
}
