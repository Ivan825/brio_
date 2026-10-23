// The workspace's policies (M9), read where they are enforced: the router, the dispatch, sandboxes, quick starts.
import { type PolicyAgent, type PolicyRow, routable } from "@brio/core";
import { type DbOrTx, schema } from "@brio/db";
import { and, eq } from "drizzle-orm";

export async function loadPolicies(db: DbOrTx, workspaceId: string): Promise<PolicyRow[]> {
  const rows = await db
    .select()
    .from(schema.policies)
    .where(and(eq(schema.policies.workspaceId, workspaceId), eq(schema.policies.enabled, true)));
  return rows.map((r) => ({ kind: r.kind, name: r.name, rule: r.rule, enabled: r.enabled }));
}

/** Agents the policies allow for work of this sensitivity, and why the others are not. */
export function allowedAgents<A extends PolicyAgent>(
  agents: readonly A[],
  sensitivity: "public" | "internal" | "confidential",
  policies: readonly PolicyRow[],
): { allowed: A[]; refused: string[] } {
  const allowed: A[] = [];
  const refused: string[] = [];
  for (const a of agents) {
    const v = routable(a, sensitivity, policies);
    if (v.ok) allowed.push(a);
    else refused.push(v.reason);
  }
  return { allowed, refused };
}
