// `brio runner` (BUILD_PLAN M8): register this machine as a local runner, start the daemon, see what runs where.
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { DEFAULT_IMAGES, detectCapabilities, LocalRunner } from "@brio/runner";
import { type Args, str } from "./args";
import { BrioClient } from "./client";
import { type Io, UsageError } from "./commands";
import { loadConfig, saveConfig } from "./config";

interface RunnerRow {
  id: string;
  name: string;
  mode: string;
  online: boolean;
  lastSeenAt: string | null;
  capabilities: { clis?: Array<{ key: string; version: string }>; docker?: boolean };
}

async function signedIn(io: Io) {
  const config = await loadConfig(io.configPath);
  if (!config) throw new UsageError("not signed in: run `brio login` first");
  const client = new BrioClient({
    url: config.url,
    session: config.session,
    workspaceId: config.workspaceId,
    ...(io.fetch ? { fetch: io.fetch } : {}),
  });
  return { config, client };
}

/** Asks on the terminal; refuses without one (pass --yes to accept non-interactively). */
async function confirm(io: Io, question: string): Promise<boolean> {
  if (!io.tty || !process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [yes/no] `)).trim());
  } finally {
    rl.close();
  }
}

export async function runner(a: Args, io: Io): Promise<void> {
  const sub = a._[1] ?? "status";
  if (sub === "register") return register(a, io);
  if (sub === "start") return start(a, io);
  if (sub === "status") return status(io);
  throw new UsageError("brio runner register | start | status");
}

/**
 * `brio runner register --name laptop [--host [--yes]]`: makes this machine a runner of the workspace. Host mode runs
 * agents without a container, so it asks for consent first and the API records it.
 */
async function register(a: Args, io: Io): Promise<void> {
  const { config, client } = await signedIn(io);
  const name = str(a, "name") ?? process.env.HOSTNAME ?? "my machine";
  const host = Boolean(a.flags.host);
  if (host) {
    const { hostModeConsent } = await client.get<{ hostModeConsent: string }>("/v1/runners");
    io.out(`Host mode: ${hostModeConsent}\n`);
    if (!a.flags.yes && !(await confirm(io, "Do you agree?")))
      throw new UsageError(
        "host mode needs your consent: run again with --yes to agree, or without --host for Docker",
      );
  }
  const { runner: r, token } = await client.post<{
    runner: { id: string; name: string; mode: "docker" | "host" };
    token: string;
  }>("/v1/runners", { name, mode: host ? "host" : "docker", ...(host ? { acceptHostMode: true } : {}) });
  await saveConfig(io.configPath, { ...config, runner: { id: r.id, name: r.name, token, mode: r.mode } });
  io.out(`Registered ${r.name} (${r.mode}). Start it with: brio runner start\n`);
}

/** `brio runner start [--api URL] [--dir path]`: connects and runs this machine's work until stopped (Ctrl-C). */
async function start(a: Args, io: Io): Promise<void> {
  const config = await loadConfig(io.configPath);
  if (!config?.runner)
    throw new UsageError("this machine is not a runner yet: run `brio runner register` first");
  const url = str(a, "api") ?? io.env.BRIO_API_URL ?? config.url;
  const dir = str(a, "dir") ?? join(homedir(), ".brio", "local-runner");
  const capabilities = await detectCapabilities(io.env);
  io.out(
    `Found: ${capabilities.clis.map((c) => `${c.key} (${c.version})`).join(", ") || "no coding CLIs"}${capabilities.docker ? "; Docker" : ""}\n`,
  );
  const say = (level: string) => (o: Record<string, unknown> | string, msg?: string) =>
    io.err(`${level} ${msg ?? ""} ${typeof o === "string" ? o : JSON.stringify(o)}\n`);
  const daemon = new LocalRunner({
    url,
    token: config.runner.token,
    dir,
    images: DEFAULT_IMAGES,
    env: io.env,
    capabilities,
    log: { debug: () => {}, info: say("info"), warn: say("warn"), error: say("error") },
  });
  await daemon.start();
  io.out(`${config.runner.name} is connected to ${url} (${config.runner.mode} mode). Ctrl-C stops it.\n`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      void daemon.stop().then(resolve);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

async function status(io: Io): Promise<void> {
  const { config, client } = await signedIn(io);
  const { runners } = await client.get<{ runners: RunnerRow[] }>("/v1/runners");
  if (!runners.length)
    io.out("No local runners. Make this machine one: brio runner register --name laptop\n");
  for (const r of runners)
    io.out(
      `${r.id === config.runner?.id ? "*" : " "} ${r.name.padEnd(20)} ${r.mode.padEnd(7)} ${r.online ? "online " : "offline"} ${(r.capabilities.clis ?? []).map((c) => c.key).join(", ")}\n`,
    );
}
