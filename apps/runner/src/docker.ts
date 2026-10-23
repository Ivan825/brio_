// A thin wrapper over the docker CLI. The runner host has Docker; sandboxes never get the Docker socket.
import { spawn } from "node:child_process";

export class DockerError extends Error {
  override name = "DockerError";
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export interface DockerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const TAIL = 64 * 1024;
const tail = (s: string) => (s.length > TAIL ? s.slice(-TAIL) : s);

/** Runs `docker <args>` to completion. Throws DockerError on a non-zero exit unless `allowFail`. */
export function docker(
  args: string[],
  opts: { input?: string | Buffer; allowFail?: boolean; timeoutMs?: number } = {},
): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = tail(stderr + d.toString("utf8"));
    });
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : null;
    child.on("error", (e) => reject(new DockerError(`cannot run docker: ${e.message}`, null, "")));
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0 && !opts.allowFail)
        return reject(
          new DockerError(`docker ${args[0]} failed (${code}): ${stderr.trim().slice(-500)}`, code, stderr),
        );
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(opts.input ?? "");
  });
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    await docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export async function imageExists(tag: string): Promise<boolean> {
  return (await docker(["image", "inspect", tag], { allowFail: true })).code === 0;
}

/** Removes containers and networks carrying a label (used on teardown and by the reaper). */
export async function removeByLabel(label: string): Promise<number> {
  const ps = await docker(["ps", "-aq", "--filter", `label=${label}`], { allowFail: true });
  const ids = ps.stdout.split("\n").filter(Boolean);
  if (ids.length) await docker(["rm", "-f", ...ids], { allowFail: true });
  const nets = await docker(["network", "ls", "-q", "--filter", `label=${label}`], { allowFail: true });
  const netIds = nets.stdout.split("\n").filter(Boolean);
  if (netIds.length) await docker(["network", "rm", ...netIds], { allowFail: true });
  return ids.length;
}
