// The policy engine (M9): data routing by sensitivity, the connector allow-list, network rules and quick-start limits.
import { describe, expect, it } from "vitest";
import {
  applyNetworkPolicy,
  type PolicyAgent,
  type PolicyRow,
  quickStartLimits,
  routable,
} from "../src/policy/policy";

const agent = (
  registryKey: string,
  local = false,
  connectorId = "00000000-0000-4000-8000-000000000001",
): PolicyAgent => ({
  registryKey,
  connectorId,
  local,
});
const row = (kind: PolicyRow["kind"], rule: unknown, enabled = true): PolicyRow => ({
  kind,
  name: kind,
  rule,
  enabled,
});

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("data routing", () => {
  it("keeps confidential work on local models by default, and lets a policy widen it", () => {
    expect(routable(agent("ollama", true), "confidential", []).ok).toBe(true);
    expect(routable(agent("openai-api"), "confidential", [])).toMatchObject({ ok: false });
    expect(routable(agent("openai-api"), "internal", []).ok).toBe(true);
    const azure = row("data_routing", {
      sensitivity: "confidential",
      allow: { connectors: ["azure-openai"] },
    });
    expect(routable(agent("azure-openai"), "confidential", [azure]).ok).toBe(true);
    // With a policy, only what it allows: local models no longer by default.
    expect(routable(agent("ollama", true), "confidential", [azure]).ok).toBe(false);
    expect(routable(agent("openai-api"), "confidential", [azure]).ok).toBe(false);
    expect(
      routable(agent("openai-api"), "confidential", [{ ...azure, connectors: [] } as PolicyRow]).ok,
    ).toBe(false);
    // A disabled policy does nothing.
    expect(routable(agent("azure-openai"), "confidential", [{ ...azure, enabled: false }]).ok).toBe(false);
  });

  it("applies the connector allow-list to every sensitivity; deny wins", () => {
    const allow = row("connector_allow", { allow: ["claude-api", "ollama"] });
    const deny = row("connector_allow", { deny: ["ollama"] });
    expect(routable(agent("claude-api"), "public", [allow]).ok).toBe(true);
    expect(routable(agent("openai-api"), "public", [allow])).toMatchObject({ ok: false });
    expect(routable(agent("ollama", true), "confidential", [allow, deny])).toMatchObject({ ok: false });
  });

  it("never lets confidential work reach a disallowed connector (property test, 5,000 random workspaces)", () => {
    const rng = seeded(20261024);
    const KEYS = [
      "openai-api",
      "claude-api",
      "gemini-api",
      "ollama",
      "lm-studio",
      "azure-openai",
      "groq-api",
    ];
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rng() * xs.length)] as T;
    for (let run = 0; run < 5000; run++) {
      const rows: PolicyRow[] = [];
      const allowed = new Set<string>();
      let anyRouting = false;
      for (let i = Math.floor(rng() * 3); i > 0; i--) {
        const connectors = KEYS.filter(() => rng() > 0.6);
        const local = rng() > 0.5;
        const enabled = rng() > 0.2;
        if (!connectors.length && !local) continue;
        rows.push(
          row("data_routing", { sensitivity: "confidential", allow: { connectors, local } }, enabled),
        );
        if (enabled) {
          anyRouting = true;
          for (const c of connectors) allowed.add(c);
          if (local) allowed.add("<local>");
        }
      }
      const denied = rng() > 0.7 ? [pick(KEYS)] : [];
      if (denied.length) rows.push(row("connector_allow", { deny: denied }));
      const a = agent(pick(KEYS), rng() > 0.6);
      const verdict = routable(a, "confidential", rows);
      const mayGo =
        !denied.includes(a.registryKey) &&
        (anyRouting ? allowed.has(a.registryKey) || (a.local && allowed.has("<local>")) : a.local);
      expect(verdict.ok, JSON.stringify({ a, rows })).toBe(mayGo);
    }
  });
});

describe("network and approvals", () => {
  it("removes denied hosts and adds allowed ones to code sandboxes only", () => {
    const rows = [
      row("network", { denyHosts: ["registry.npmjs.org", "*.pypi.org"], allowHosts: ["npm.acme.internal"] }),
    ];
    expect(
      applyNetworkPolicy(["registry.npmjs.org", "files.pypi.org", "pypi.org", "github.com"], rows, {
        code: true,
      }),
    ).toEqual(["github.com", "npm.acme.internal"]);
    expect(applyNetworkPolicy(["github.com"], rows, { code: false })).toEqual(["github.com"]);
  });

  it("starts plans without a person under the strictest approval policy, else $5 and 10 tasks", () => {
    expect(quickStartLimits([])).toEqual({ autoUnderUsd: 5, autoUnderTasks: 10 });
    expect(
      quickStartLimits([
        row("approval", { action: "approve_plan", autoUnderUsd: 2, autoUnderTasks: 20 }),
        row("approval", { action: "approve_plan", autoUnderUsd: 8, autoUnderTasks: 4 }),
      ]),
    ).toEqual({ autoUnderUsd: 2, autoUnderTasks: 4 });
  });
});
