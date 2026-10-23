import { z } from "zod";
import { Id, Json, Sha256, Timestamp, Usd, WorkspaceScoped } from "./common";

export const BudgetScopeKind = z.enum(["workspace", "mission", "task", "agent"]);

export const Budget = WorkspaceScoped.extend({
  scopeKind: BudgetScopeKind,
  scopeId: Id,
  limitUsd: Usd.nullable(),
  limitMinutes: z.number().positive().nullable(),
  spentUsd: Usd,
  /** Percentage of the limit at which a budget.warn event fires. */
  softPct: z.number().int().min(1).max(100),
});
export type Budget = z.infer<typeof Budget>;

export const PolicyKind = z.enum(["data_routing", "network", "approval", "connector_allow"]);

export const Policy = WorkspaceScoped.extend({
  kind: PolicyKind,
  name: z.string().min(1).max(120),
  rule: Json,
  enabled: z.boolean(),
});
export type Policy = z.infer<typeof Policy>;

export const ApprovalStatus = z.enum(["pending", "approved", "denied", "expired", "cancelled"]);

/** Irreversible actions (push, deploy, send, purchase, delete) wait on an approval (CLAUDE.md rule 6). */
export const Approval = WorkspaceScoped.extend({
  subjectKind: z.string().min(1),
  subjectId: Id,
  action: z.string().min(1),
  requestedBy: z.string().min(1),
  status: ApprovalStatus,
  decidedBy: Id.nullable(),
  decidedAt: Timestamp.nullable(),
  reason: z.string().nullable(),
});
export type Approval = z.infer<typeof Approval>;

export const LedgerKind = z.enum([
  "dispatch",
  "spend",
  "approval.decision",
  "side_effect",
  "policy.change",
  "key.added",
  "key.rotated",
  "key.removed",
  "workspace.created",
  "member.invited",
]);
export type LedgerKind = z.infer<typeof LedgerKind>;

/** Append-only, hash-chained ledger entry (SECURITY_GOVERNANCE.md §8). No updates or deletes. */
export const LedgerEntry = z.object({
  id: Id,
  workspaceId: Id,
  seq: z.number().int().positive(),
  prevHash: Sha256,
  hash: Sha256,
  kind: LedgerKind,
  payload: Json,
  createdAt: Timestamp,
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;
