// Postgres enums built from the Zod enums in @brio/schema, so the database and the API share one list.
import {
  ApprovalStatus,
  ArtifactKind,
  AttemptRole,
  AttemptStatus,
  BudgetScopeKind,
  ConnectorRoute,
  ConnectorStatus,
  ContractStatus,
  ExecutionMode,
  InvitationStatus,
  LeaseMode,
  LeaseResourceKind,
  LedgerKind,
  MemberRole,
  MessageKind,
  MessageStatus,
  MissionPriority,
  MissionStatus,
  PlanStatus,
  PolicyKind,
  ProjectKind,
  ReviewKind,
  SandboxProfile,
  TaskStatus,
  Verdict,
  WorkspacePlan,
} from "@brio/schema";
import { pgEnum } from "drizzle-orm/pg-core";

const values = <T extends string>(e: { options: readonly T[] }) => e.options as [T, ...T[]];

export const workspacePlan = pgEnum("workspace_plan", values(WorkspacePlan));
export const memberRole = pgEnum("member_role", values(MemberRole));
export const invitationStatus = pgEnum("invitation_status", values(InvitationStatus));
export const connectorRoute = pgEnum("connector_route", values(ConnectorRoute));
export const connectorStatus = pgEnum("connector_status", values(ConnectorStatus));
export const sandboxProfile = pgEnum("sandbox_profile", values(SandboxProfile));
export const projectKind = pgEnum("project_kind", values(ProjectKind));
export const missionStatus = pgEnum("mission_status", values(MissionStatus));
export const missionPriority = pgEnum("mission_priority", values(MissionPriority));
export const planStatus = pgEnum("plan_status", values(PlanStatus));
export const executionMode = pgEnum("execution_mode", values(ExecutionMode));
export const taskStatus = pgEnum("task_status", values(TaskStatus));
export const attemptRole = pgEnum("attempt_role", values(AttemptRole));
export const attemptStatus = pgEnum("attempt_status", values(AttemptStatus));
export const artifactKind = pgEnum("artifact_kind", values(ArtifactKind));
export const reviewKind = pgEnum("review_kind", values(ReviewKind));
export const verdict = pgEnum("verdict", values(Verdict));
export const contractStatus = pgEnum("contract_status", values(ContractStatus));
export const leaseResourceKind = pgEnum("lease_resource_kind", values(LeaseResourceKind));
export const leaseMode = pgEnum("lease_mode", values(LeaseMode));
export const messageKind = pgEnum("message_kind", values(MessageKind));
export const messageStatus = pgEnum("message_status", values(MessageStatus));
export const budgetScopeKind = pgEnum("budget_scope_kind", values(BudgetScopeKind));
export const policyKind = pgEnum("policy_kind", values(PolicyKind));
export const approvalStatus = pgEnum("approval_status", values(ApprovalStatus));
export const ledgerKind = pgEnum("ledger_kind", values(LedgerKind));
export const scoreScope = pgEnum("score_scope", ["workspace", "global"]);
export const memoryNodeKind = pgEnum("memory_node_kind", [
  "decision",
  "contract",
  "file",
  "preference",
  "fact",
  "task",
  "agent",
  "prompt",
]);
export const memoryEdgeKind = pgEnum("memory_edge_kind", [
  "decided_in",
  "implements",
  "touches",
  "prompted_by",
  "supersedes",
  "depends_on",
]);
