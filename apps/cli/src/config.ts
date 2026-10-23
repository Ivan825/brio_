// Where `brio login` keeps its session: $BRIO_CONFIG, else $XDG_CONFIG_HOME/brio/config.json, else
// ~/.config/brio/config.json. Readable by the user only: it holds a session that acts as them.
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CliConfig {
  /** The Brio web app's origin (it proxies the API), e.g. https://brio.example. */
  url: string;
  /** The CLI's own session, from the device flow. */
  session: string;
  email: string;
  workspaceId: string | null;
  workspaceName: string | null;
  /** This machine as a local runner (M8): its id and token from `brio runner register`. */
  runner?: { id: string; name: string; token: string; mode: "docker" | "host" };
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BRIO_CONFIG) return env.BRIO_CONFIG;
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "brio", "config.json");
}

export async function loadConfig(path: string): Promise<CliConfig | null> {
  try {
    const c = JSON.parse(await readFile(path, "utf8")) as Partial<CliConfig>;
    if (!c.url || !c.session) return null;
    return {
      url: c.url,
      session: c.session,
      email: c.email ?? "",
      workspaceId: c.workspaceId ?? null,
      workspaceName: c.workspaceName ?? null,
      ...(c.runner ? { runner: c.runner } : {}),
    };
  } catch {
    return null;
  }
}

export async function saveConfig(path: string, c: CliConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function removeConfig(path: string): Promise<void> {
  await rm(path, { force: true });
}
