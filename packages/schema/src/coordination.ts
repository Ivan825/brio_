import { z } from "zod";
import { Id, Timestamp, WorkspaceScoped } from "./common";

export const ContractStatus = z.enum(["draft", "active", "superseded"]);

/** A shared interface contract between tasks (OpenAPI, TS types, a schema...). */
export const Contract = WorkspaceScoped.extend({
  projectId: Id.nullable(),
  name: z.string().min(1).max(120),
  version: z.string().min(1),
  spec: z.union([z.string(), z.record(z.string(), z.unknown())]),
  ownerTaskId: Id.nullable(),
  status: ContractStatus,
});
export type Contract = z.infer<typeof Contract>;

export const LeaseResourceKind = z.enum(["path", "glob", "symbol", "contract", "external"]);
export const LeaseMode = z.enum(["exclusive", "shared"]);

export const Lease = WorkspaceScoped.extend({
  taskId: Id,
  resourceKind: LeaseResourceKind,
  resource: z.string().min(1),
  mode: LeaseMode,
  expiresAt: Timestamp,
  releasedAt: Timestamp.nullable(),
});
export type Lease = z.infer<typeof Lease>;

export const MessageKind = z.enum(["question", "answer", "review_request", "blocker", "note"]);
export const MessageStatus = z.enum(["open", "answered", "closed"]);

/** Agent mailbox message. Exactly one recipient: a task, an attempt or the user. */
export const Message = WorkspaceScoped.extend({
  missionId: Id,
  fromAttemptId: Id.nullable(),
  toTaskId: Id.nullable(),
  toAttemptId: Id.nullable(),
  toUser: z.boolean(),
  kind: MessageKind,
  body: z.string().min(1),
  status: MessageStatus,
}).refine((m) => [m.toTaskId !== null, m.toAttemptId !== null, m.toUser].filter(Boolean).length === 1, {
  message: "a message has exactly one recipient",
  path: ["toTaskId"],
});
export type Message = z.infer<typeof Message>;
