// Sandbox profiles (ARCHITECTURE §5, SECURITY_GOVERNANCE §3) and the choice of one for an attempt. Pure: the runner
// turns a SandboxSpec into a container.

export type SandboxProfileName = "code-standard" | "code-heavy" | "api-only" | "browser" | "media";

export interface SandboxSpec {
  profile: SandboxProfileName;
  cpus: number;
  memoryMb: number;
  pids: number;
  timeoutMinutes: number;
  /** none: no network at all. allowlist: egress only through the proxy, only to these hosts. */
  network: { mode: "none" } | { mode: "allowlist"; hosts: string[] };
  /** The worktree is writable; everything else read-only. */
  worktree: "rw" | "ro" | "none";
}

/** Hosts every code sandbox may reach: package registries and git hosting. */
export const CODE_HOSTS = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "proxy.golang.org",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
];

export const PROFILES: Record<SandboxProfileName, Omit<SandboxSpec, "network" | "worktree" | "profile">> = {
  "code-standard": { cpus: 2, memoryMb: 4096, pids: 512, timeoutMinutes: 45 },
  "code-heavy": { cpus: 4, memoryMb: 8192, pids: 1024, timeoutMinutes: 90 },
  "api-only": { cpus: 0.5, memoryMb: 512, pids: 128, timeoutMinutes: 15 },
  browser: { cpus: 2, memoryMb: 4096, pids: 512, timeoutMinutes: 30 },
  media: { cpus: 0.5, memoryMb: 1024, pids: 128, timeoutMinutes: 30 },
};

/** The agent's own setting (agents.sandbox_profile): how much of the worktree and network it gets. */
export type AgentSandboxSetting = "none" | "readonly" | "standard" | "networked";

export interface SandboxChoiceInput {
  route: "api" | "cli" | "sdk" | "hosted" | "a2a" | "mcp" | "browser" | "local";
  taskType: string;
  agentSetting: AgentSandboxSetting;
  /** Hosts the agent itself must reach from inside the sandbox (a CLI's vendor API). */
  vendorHosts: readonly string[];
  /** Task-level minutes limit; the profile's cap still applies. */
  maxMinutes: number;
}

/**
 * Whether an API-model attempt needs a sandbox at all: only when it works on files (code, design artefacts such as
 * contracts and schemas, and data tasks).
 */
export function needsSandbox(i: Pick<SandboxChoiceInput, "route" | "taskType" | "agentSetting">): boolean {
  if (i.route === "cli") return true;
  if (i.agentSetting === "none") return false;
  return (
    i.taskType.startsWith("code.") ||
    i.taskType === "merge.integrate" ||
    i.taskType.startsWith("data.") ||
    i.taskType.startsWith("design.")
  );
}

const unique = (xs: readonly string[]) => [...new Set(xs.map((h) => h.toLowerCase()))].sort();

/**
 * The sandbox for an attempt, or null when it needs none. Default deny: no network unless the agent's own vendor
 * must be reached from inside (CLIs) or the agent is explicitly "networked"; code profiles add registries and git.
 */
export function chooseSandbox(i: SandboxChoiceInput): SandboxSpec | null {
  if (!needsSandbox(i)) return null;
  const heavy = i.taskType === "code.infra_devops" || i.taskType === "code.data_pipeline";
  const profile: SandboxProfileName =
    i.route === "cli" || i.taskType.startsWith("code.") || i.taskType === "merge.integrate"
      ? heavy
        ? "code-heavy"
        : "code-standard"
      : "api-only";
  const base = PROFILES[profile];
  const code = profile !== "api-only";
  const hosts = [
    ...i.vendorHosts,
    ...(code && (i.route === "cli" || i.agentSetting === "networked") ? CODE_HOSTS : []),
  ];
  return {
    profile,
    ...base,
    timeoutMinutes: Math.max(1, Math.min(base.timeoutMinutes, i.maxMinutes)),
    network: hosts.length ? { mode: "allowlist", hosts: unique(hosts) } : { mode: "none" },
    worktree: i.agentSetting === "readonly" ? "ro" : "rw",
  };
}

/** Exact host or a leading-dot suffix rule (".example.com" matches sub.example.com but not example.com). */
export function hostAllowed(host: string, allow: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allow.some((rule) =>
    rule.startsWith(".") ? h.endsWith(rule) && h.length > rule.length : h === rule,
  );
}
