import { z } from "zod";
import { Json, SoftDeletable, WorkspaceScoped } from "./common";

export const ProjectKind = z.enum(["git", "files"]);

export const Project = WorkspaceScoped.extend({
  name: z.string().trim().min(1).max(80),
  kind: ProjectKind,
  repoUrl: z.url().nullable(),
  defaultBranch: z.string().min(1).nullable(),
  settings: Json,
}).extend(SoftDeletable.shape);
export type Project = z.infer<typeof Project>;
