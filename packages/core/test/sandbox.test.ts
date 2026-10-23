import { describe, expect, it } from "vitest";
import { CODE_HOSTS, chooseSandbox, hostAllowed, needsSandbox, PROFILES } from "../src/index";

const base = { vendorHosts: [], maxMinutes: 60 } as const;

describe("sandbox choice", () => {
  it("gives API models a sandbox only when they work on files", () => {
    expect(needsSandbox({ route: "api", taskType: "write.doc", agentSetting: "standard" })).toBe(false);
    expect(needsSandbox({ route: "api", taskType: "code.feature", agentSetting: "standard" })).toBe(true);
    expect(needsSandbox({ route: "api", taskType: "code.feature", agentSetting: "none" })).toBe(false);
    expect(needsSandbox({ route: "cli", taskType: "write.doc", agentSetting: "none" })).toBe(true);
    // A writing task whose contract changes repository files (a README) gets a worktree too.
    expect(
      needsSandbox({ route: "api", taskType: "write.doc", agentSetting: "standard", writesFiles: true }),
    ).toBe(true);
  });

  it("CLIs get code-standard with their vendor host plus registries and git, nothing else", () => {
    const s = chooseSandbox({
      ...base,
      route: "cli",
      taskType: "code.tests",
      agentSetting: "standard",
      vendorHosts: ["api.anthropic.com"],
    });
    expect(s).toMatchObject({
      profile: "code-standard",
      cpus: 2,
      memoryMb: 4096,
      timeoutMinutes: 45,
      worktree: "rw",
    });
    expect(s?.network).toEqual({
      mode: "allowlist",
      hosts: [...new Set(["api.anthropic.com", ...CODE_HOSTS])].sort(),
    });
  });

  it("API models editing files get no network unless the agent is networked", () => {
    const s = chooseSandbox({ ...base, route: "api", taskType: "code.feature", agentSetting: "standard" });
    expect(s?.network).toEqual({ mode: "none" });
    const n = chooseSandbox({ ...base, route: "api", taskType: "code.feature", agentSetting: "networked" });
    expect(n?.network.mode).toBe("allowlist");
  });

  it("uses code-heavy for infra and pipelines, api-only for data work, and never exceeds the task's minutes", () => {
    expect(
      chooseSandbox({ ...base, route: "cli", taskType: "code.infra_devops", agentSetting: "standard" })
        ?.profile,
    ).toBe("code-heavy");
    expect(
      chooseSandbox({ ...base, route: "api", taskType: "data.analysis", agentSetting: "standard" }),
    ).toMatchObject({
      profile: "api-only",
      ...PROFILES["api-only"],
      network: { mode: "none" },
    });
    expect(
      chooseSandbox({
        ...base,
        route: "cli",
        taskType: "code.feature",
        agentSetting: "standard",
        maxMinutes: 5,
      })?.timeoutMinutes,
    ).toBe(5);
  });

  it("read-only agents get a read-only worktree", () => {
    expect(
      chooseSandbox({ ...base, route: "cli", taskType: "code.review", agentSetting: "readonly" })?.worktree,
    ).toBe("ro");
  });
});

describe("host allowlist", () => {
  it("matches exact hosts and dot-suffix rules only", () => {
    const allow = ["api.anthropic.com", ".githubusercontent.com"];
    expect(hostAllowed("api.anthropic.com", allow)).toBe(true);
    expect(hostAllowed("API.Anthropic.com.", allow)).toBe(true);
    expect(hostAllowed("objects.githubusercontent.com", allow)).toBe(true);
    expect(hostAllowed("githubusercontent.com", allow)).toBe(false);
    expect(hostAllowed("evil-api.anthropic.com", allow)).toBe(false);
    expect(hostAllowed("api.anthropic.com.evil.test", allow)).toBe(false);
  });
});
