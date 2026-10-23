// The policy engine (BUILD_PLAN M9, SECURITY_GOVERNANCE §4): which agents may take a task given its data
// sensitivity and the workspace's connector allow-list, what a sandbox may reach, and when a plan starts without a
// person. Pure: the router filters candidates with it before scoring and the dispatch checks it again, so a
// violation is impossible rather than warned about.
import { Sensitivity } from "@brio/schema";
import { z } from "zod";

/** Which agents may take tasks of a sensitivity: local models, named registry connectors, or named installed ones. */
export const DataRoutingRule = z.object({
  sensitivity: Sensitivity,
  allow: z
    .object({
      local: z.boolean().optional(),
      connectors: z.array(z.string().min(1)).max(200).optional(),
      connectorIds: z.array(z.uuid()).max(200).optional(),
    })
    .refine((a) => a.local || a.connectors?.length || a.connectorIds?.length, "allow something"),
});

/** The workspace's connector allow-list (registry ids); deny wins. */
export const ConnectorAllowRule = z
  .object({
    allow: z.array(z.string().min(1)).max(200).optional(),
    deny: z.array(z.string().min(1)).max(200).optional(),
  })
  .refine((r) => r.allow?.length || r.deny?.length, "allow or deny something");

/** Hosts sandboxes may never reach, and hosts code sandboxes may also reach (an internal package registry). */
const Host = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(\*\.)?[a-z0-9.-]+\.[a-z]{2,}$/, "a host name");
export const NetworkRule = z
  .object({ allowHosts: z.array(Host).max(100).optional(), denyHosts: z.array(Host).max(100).optional() })
  .refine((r) => r.allowHosts?.length || r.denyHosts?.length, "allow or deny some host");

/** When a plan starts without a person (a quick start): under these limits. */
export const ApprovalRule = z.object({
  action: z.literal("approve_plan"),
  autoUnderUsd: z.number().min(0).max(100_000),
  autoUnderTasks: z.number().int().min(0).max(1000),
});

export const PolicyRule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("data_routing"), rule: DataRoutingRule }),
  z.object({ kind: z.literal("connector_allow"), rule: ConnectorAllowRule }),
  z.object({ kind: z.literal("network"), rule: NetworkRule }),
  z.object({ kind: z.literal("approval"), rule: ApprovalRule }),
]);

export interface PolicyRow {
  kind: "data_routing" | "connector_allow" | "network" | "approval";
  name: string;
  rule: unknown;
  enabled: boolean;
}

/** What the policies need to know about an agent. */
export interface PolicyAgent {
  /** The registry connector, e.g. "openai-api", "ollama". */
  registryKey: string;
  connectorId: string;
  /** A model served on the person's own hardware (Ollama, LM Studio…). */
  local: boolean;
}

const enabled = <K extends PolicyRow["kind"]>(rows: readonly PolicyRow[], kind: K) =>
  rows.filter((r) => r.enabled && r.kind === kind);

/**
 * Whether an agent may take a task of this sensitivity. Without a data-routing policy for confidential work only local
 * models may take it (fail closed); public and internal work goes anywhere the connector allow-list lets it.
 */
export function routable(
  a: PolicyAgent,
  sensitivity: Sensitivity,
  rows: readonly PolicyRow[],
): { ok: true } | { ok: false; reason: string } {
  for (const p of enabled(rows, "connector_allow")) {
    const r = ConnectorAllowRule.safeParse(p.rule);
    if (!r.success) continue;
    if (r.data.deny?.includes(a.registryKey))
      return { ok: false, reason: `policy "${p.name}" denies ${a.registryKey}` };
  }
  const allows = enabled(rows, "connector_allow")
    .map((p) => ConnectorAllowRule.safeParse(p.rule))
    .filter((r) => r.success && r.data.allow?.length)
    .flatMap((r) => r.data?.allow ?? []);
  if (allows.length && !allows.includes(a.registryKey))
    return { ok: false, reason: `${a.registryKey} is not on the workspace's connector allow-list` };

  const routing = enabled(rows, "data_routing")
    .map((p) => ({ name: p.name, r: DataRoutingRule.safeParse(p.rule) }))
    .filter((x) => x.r.success && x.r.data.sensitivity === sensitivity);
  if (!routing.length)
    return sensitivity === "confidential" && !a.local
      ? {
          ok: false,
          reason: "confidential work goes only to local models unless a data-routing policy allows more",
        }
      : { ok: true };
  const allowed = routing.some(({ r }) => {
    const allow = r.data?.allow;
    return Boolean(
      (allow?.local && a.local) ||
        allow?.connectors?.includes(a.registryKey) ||
        allow?.connectorIds?.includes(a.connectorId),
    );
  });
  return allowed
    ? { ok: true }
    : {
        ok: false,
        reason: `${sensitivity} work may not go to ${a.registryKey} (policy ${routing.map((x) => `"${x.name}"`).join(", ")})`,
      };
}

/** A sandbox's egress allowlist under the network policies: denied hosts out, allowed ones in (code sandboxes only). */
export function applyNetworkPolicy(
  hosts: readonly string[],
  rows: readonly PolicyRow[],
  opts: { code: boolean },
): string[] {
  const rules = enabled(rows, "network")
    .map((p) => NetworkRule.safeParse(p.rule))
    .filter((r) => r.success)
    .map((r) => r.data as z.infer<typeof NetworkRule>);
  const deny = rules.flatMap((r) => r.denyHosts ?? []);
  const denied = (h: string) =>
    deny.some((d) => (d.startsWith("*.") ? h === d.slice(2) || h.endsWith(d.slice(1)) : h === d));
  const extra = opts.code ? rules.flatMap((r) => r.allowHosts ?? []) : [];
  return [...new Set([...hosts, ...extra])].filter((h) => !denied(h));
}

export const DEFAULT_QUICK_START = { autoUnderUsd: 5, autoUnderTasks: 10 } as const;

/** The limits under which a plan starts without a person: the workspace's approval policy, or $5 and 10 tasks. */
export function quickStartLimits(rows: readonly PolicyRow[]): {
  autoUnderUsd: number;
  autoUnderTasks: number;
} {
  const rules = enabled(rows, "approval")
    .map((p) => ApprovalRule.safeParse(p.rule))
    .filter((r) => r.success)
    .map((r) => r.data as z.infer<typeof ApprovalRule>);
  if (!rules.length) return { ...DEFAULT_QUICK_START };
  // The strictest enabled policy wins.
  return {
    autoUnderUsd: Math.min(...rules.map((r) => r.autoUnderUsd)),
    autoUnderTasks: Math.min(...rules.map((r) => r.autoUnderTasks)),
  };
}
