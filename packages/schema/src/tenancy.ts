import { z } from "zod";
import { Id, Json, SoftDeletable, Timestamp } from "./common";

export const WorkspacePlan = z.enum(["free", "pro", "team", "enterprise", "self_host"]);

export const Workspace = z
  .object({
    id: Id,
    name: z.string().trim().min(1).max(80),
    slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/, "lowercase letters, digits and dashes"),
    plan: WorkspacePlan,
    settings: Json,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .extend(SoftDeletable.shape);
export type Workspace = z.infer<typeof Workspace>;

export const MemberRole = z.enum(["owner", "admin", "member", "viewer"]);
export type MemberRole = z.infer<typeof MemberRole>;

export const Member = z.object({
  id: Id,
  workspaceId: Id,
  userId: Id,
  role: MemberRole,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Member = z.infer<typeof Member>;

export const InvitationStatus = z.enum(["pending", "accepted", "rejected", "canceled"]);

export const Invitation = z.object({
  id: Id,
  workspaceId: Id,
  email: z.email(),
  role: MemberRole,
  status: InvitationStatus,
  inviterId: Id,
  expiresAt: Timestamp,
  createdAt: Timestamp,
});
export type Invitation = z.infer<typeof Invitation>;
