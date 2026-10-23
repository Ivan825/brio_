import { z } from "zod";
import { Usd } from "./common";

/** Acceptance check kinds (docs/ROUTING_AND_QUALITY.md §4.1). */
export const AcceptanceCheckKind = z.enum([
  "tests",
  "typecheck",
  "lint",
  "build",
  "contract_conformance",
  "diff_scope",
  "rubric_review",
  "fact_check",
  "citation_present",
  "media_spec",
  "link_check",
  "a11y",
  "lighthouse",
  "human",
]);
export type AcceptanceCheckKind = z.infer<typeof AcceptanceCheckKind>;

export const AcceptanceCheck = z.object({
  kind: AcceptanceCheckKind,
  /** Hard checks gate the verdict; soft checks only inform it. */
  hard: z.boolean().default(true),
  /** Shell command for tests/typecheck/lint/build, run inside the sandbox. */
  command: z.string().optional(),
  /** Criteria for rubric_review. */
  criteria: z.array(z.string()).optional(),
  /** Pass threshold (1–5) for rubric_review. */
  threshold: z.number().min(1).max(5).optional(),
  /** Contract name for contract_conformance. */
  contract: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type AcceptanceCheck = z.infer<typeof AcceptanceCheck>;

export const ContractInput = z.object({
  kind: z.enum(["file", "artifact", "contract", "text", "url"]),
  ref: z.string().min(1),
});

export const ArtifactKind = z.enum([
  "diff",
  "file",
  "doc",
  "url",
  "image",
  "video",
  "audio",
  "dataset",
  "report",
]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

export const ContractOutput = z.object({
  kind: ArtifactKind,
  description: z.string().min(1),
  path: z.string().optional(),
});

export const Sensitivity = z.enum(["public", "internal", "confidential"]);
export type Sensitivity = z.infer<typeof Sensitivity>;

/** Every task has a contract before dispatch (CLAUDE.md rule 4; ROUTING_AND_QUALITY.md §2). */
export const TaskContract = z.object({
  objective: z.string().min(1),
  inputs: z.array(ContractInput),
  outputs: z.array(ContractOutput).min(1),
  acceptance: z.array(AcceptanceCheck).min(1, "every task needs at least one acceptance check"),
  constraints: z.array(z.string()),
  expectedFootprint: z
    .object({ paths: z.array(z.string()), symbols: z.array(z.string()).optional() })
    .optional(),
  sensitivity: Sensitivity,
  budget: z.object({ usd: Usd.optional(), minutes: z.number().positive().optional() }).optional(),
});
export type TaskContract = z.infer<typeof TaskContract>;
