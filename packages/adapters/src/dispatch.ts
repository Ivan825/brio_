// What the API resolves and the runner executes for one attempt (stored on attempts.dispatch). Everything the run
// needs except the credential itself, which the runner reveals from the vault just in time.
import type { SandboxSpec } from "@brio/core";
import type { AgentConfig, Route, RunInput } from "./types";

export interface Dispatch {
  version: 1;
  /** Key in ADAPTERS: a model-API family or a CLI adapter. */
  adapterKey: string;
  route: Route;
  missionId: string;
  taskId: string;
  taskKey: string;
  connectorId: string;
  /** Vault secret id; null for keyless local connectors. */
  credentialRef: string | null;
  input: Omit<RunInput, "attemptId">;
  agent: AgentConfig;
  /** Null: the attempt needs no sandbox (API models on non-file tasks). */
  sandbox: SandboxSpec | null;
  /** Which sandbox image: the base, or the one with the coding CLIs installed. */
  image: "base" | "cli";
  /** The project repository to work on; null gives the mission an empty repository. */
  repo: { url: string; branch: string | null } | null;
  /**
   * Branches of finished upstream attempts (in the runner's repository cache) to start from instead of the repository
   * branch: one is used as is, several are merged. A conflict fails the attempt (merge tasks arrive in M5).
   */
  bases?: string[];
  /** Files written into the worktree's .brio/ before the run (handoff packets, the contract), never part of the diff. */
  files?: Array<{ path: string; content: string }>;
  /** Attach the repository's file list (the planner's repo map). */
  repoMap?: boolean;
  /**
   * Whether this attempt drives its task's status (single mode and direct runs). In multi-agent modes the orchestrator
   * owns the task's status and the runner leaves it alone.
   */
  manageTask?: boolean;
  /** For attempts of a multi-agent mode: what this one is for, and which attempts it reviews, judges or builds on. */
  mode?: { purpose: "make" | "revise" | "review" | "judge" | "merge"; of: string[]; step: number };
}

export type CheckStatus = "pending" | "running" | "passed" | "failed" | "needs_human";

/** One acceptance check of an attempt's result (ROUTING §4.1) and how it went. */
export interface CheckItem {
  index: number;
  kind: string;
  hard: boolean;
  command?: string;
  status: CheckStatus;
  summary?: string;
  /** Output tail, redacted. */
  output?: string;
  exitCode?: number | null;
  durationMs?: number;
}

/** attempts.checks: the verifier's working state for one attempt. */
export interface AttemptChecks {
  requestedAt: string;
  items: CheckItem[];
}
