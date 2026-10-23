import { z } from "zod";
import { Id, Json, Sha256, Timestamp, Usd, WorkspaceScoped } from "./common";
import { ArtifactKind, TaskContract } from "./contract";
import { TaskType } from "./taxonomy";

export const MissionStatus = z.enum([
  "draft",
  "planning",
  "awaiting_approval",
  "running",
  "verifying",
  "done",
  "failed",
  "cancelled",
]);
export type MissionStatus = z.infer<typeof MissionStatus>;

export const MissionBudget = z.object({ usd: Usd.optional(), minutes: z.number().positive().optional() });

export const MissionPriority = z.enum(["quality", "balanced", "cheap", "fast"]);

export const Mission = WorkspaceScoped.extend({
  projectId: Id.nullable(),
  title: z.string().trim().min(1).max(200),
  goal: z.string().trim().min(1),
  status: MissionStatus,
  priority: MissionPriority,
  budget: MissionBudget,
  assumptions: z.array(z.string()),
  report: Json.nullable(),
  createdBy: Id.nullable(),
});
export type Mission = z.infer<typeof Mission>;

export const ExecutionMode = z.enum([
  "single",
  "best_of_n",
  "ensemble",
  "maker_checker",
  "debate",
  "cascade",
  "pipeline",
]);
export type ExecutionMode = z.infer<typeof ExecutionMode>;

export const TaskStatus = z.enum([
  "pending",
  "ready",
  "leased",
  "running",
  "verifying",
  "revise",
  "done",
  "failed",
  "blocked",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** Stable slug, unique within a mission (e.g. `api.auth-routes`). */
export const TaskKey = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/, "lowercase slug");

export const Task = WorkspaceScoped.extend({
  missionId: Id,
  planVersion: z.number().int().positive(),
  key: TaskKey,
  type: TaskType,
  title: z.string().trim().min(1).max(200),
  contract: TaskContract,
  dependsOn: z.array(Id),
  mode: ExecutionMode,
  modeParams: Json,
  pinnedAgentId: Id.nullable(),
  status: TaskStatus,
  budget: MissionBudget,
  resultArtifactId: Id.nullable(),
});
export type Task = z.infer<typeof Task>;

/** A task as proposed by the planner, before it has ids (dependsOn uses task keys). */
export const PlannedTask = z.object({
  key: TaskKey,
  type: TaskType,
  title: z.string().trim().min(1).max(200),
  contract: TaskContract,
  dependsOn: z.array(TaskKey),
  suggestedMode: ExecutionMode,
  estimate: z.object({ usd: Usd, minutes: z.number().nonnegative() }).optional(),
});
export type PlannedTask = z.infer<typeof PlannedTask>;

export const PlanGraph = z.object({
  tasks: z.array(PlannedTask).min(1),
  assumptions: z.array(z.string()),
  questions: z.array(z.string()).max(3),
});
export type PlanGraph = z.infer<typeof PlanGraph>;

export const PlanStatus = z.enum(["proposed", "approved", "rejected", "superseded"]);

export const Plan = WorkspaceScoped.extend({
  missionId: Id,
  version: z.number().int().positive(),
  graph: PlanGraph,
  status: PlanStatus,
  approvedBy: Id.nullable(),
});
export type Plan = z.infer<typeof Plan>;

export const AttemptRole = z.enum(["maker", "checker", "candidate", "judge", "merger"]);
export const AttemptStatus = z.enum(["queued", "running", "succeeded", "failed", "cancelled", "timed_out"]);

export const Attempt = WorkspaceScoped.extend({
  taskId: Id,
  agentId: Id,
  role: AttemptRole,
  status: AttemptStatus,
  sandboxId: z.string().nullable(),
  worktreeRef: z.string().nullable(),
  startedAt: Timestamp.nullable(),
  endedAt: Timestamp.nullable(),
  costUsd: Usd,
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  exitReason: z.string().nullable(),
  transcriptRef: z.string().nullable(),
});
export type Attempt = z.infer<typeof Attempt>;

export const Artifact = WorkspaceScoped.extend({
  kind: ArtifactKind,
  storageRef: z.string().min(1),
  sha256: Sha256,
  meta: Json,
  attemptId: Id.nullable(),
});
export type Artifact = z.infer<typeof Artifact>;

export const ReviewKind = z.enum(["check", "review", "judge", "human"]);
export const Verdict = z.enum(["pass", "revise", "fail"]);
export type Verdict = z.infer<typeof Verdict>;

export const Review = WorkspaceScoped.extend({
  taskId: Id,
  attemptId: Id.nullable(),
  reviewerAgentId: Id.nullable(),
  reviewerUserId: Id.nullable(),
  kind: ReviewKind,
  verdict: Verdict,
  scores: z.record(z.string(), z.number()),
  reasons: z.string(),
  evidence: z.array(z.object({ kind: z.string(), ref: z.string(), summary: z.string().optional() })),
}).refine((r) => (r.reviewerAgentId === null) !== (r.reviewerUserId === null), {
  message: "a review has exactly one reviewer: an agent or a user",
  path: ["reviewerAgentId"],
});
export type Review = z.infer<typeof Review>;
