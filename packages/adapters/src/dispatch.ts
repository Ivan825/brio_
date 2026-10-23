// What the API resolves and the runner executes for one attempt (stored on attempts.dispatch). Everything the run
// needs except the credential itself, which the runner reveals from the vault just in time.
import type { SandboxSpec } from "@brio/core";
import type { AgentConfig, ConnectorConfig, Route, RunInput } from "./types";

/** A search or fetch connector of the workspace, as a tool for the attempt's agent (ADAPTER_SPEC §2.9). */
export interface ToolRef {
  connectorId: string;
  credentialRef: string | null;
  connector: ConnectorConfig;
  /** USD per billing unit; null when the vendor reports dollars or the service is unmetered. */
  usdPerUnit: number | null;
}

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
  /** Which sandbox image: the base, the one with the coding CLIs, or the browser for computer use. */
  image: "base" | "cli" | "browser";
  /** The project repository to work on; null gives the mission an empty repository. */
  repo: { url: string; branch: string | null } | null;
  /**
   * Branches of finished upstream attempts (in the runner's repository cache) to start from instead of the repository
   * branch: one is used as is, several are merged. A conflict fails the attempt (merge tasks arrive in M5).
   */
  bases?: string[];
  /** Files written into the worktree's .brio/ before the run (handoff packets, the contract), never part of the diff. */
  files?: Array<{ path: string; content: string }>;
  /** The workspace's web search and page fetch tools; absent when it has none, or for confidential tasks. */
  tools?: { search?: ToolRef; fetch?: ToolRef };
  /** Attach the repository's file list (the planner's repo map). */
  repoMap?: boolean;
  /**
   * A merge task: bases that conflict are merged with the conflict markers left in the files for the agent to resolve
   * (instead of failing the attempt).
   */
  keepConflicts?: boolean;
  /**
   * Whether this attempt drives its task's status (single mode and direct runs). In multi-agent modes the orchestrator
   * owns the task's status and the runner leaves it alone.
   */
  manageTask?: boolean;
  /** For attempts of a multi-agent mode: what this one is for, and which attempts it reviews, judges or builds on. */
  mode?: {
    /** make, revise, review, judge and merge belong to multi-agent modes; check is a verifier's agent check. */
    purpose: "make" | "revise" | "review" | "judge" | "merge" | "check";
    of: string[];
    step: number;
    /** For purpose check: the index of the check item this attempt decides. */
    checkIndex?: number;
    /** The task route (mode_params.route.id) that started it: a mode only counts its own route's attempts. */
    routeId?: string;
  };
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
  /** The check's parameters from the contract (criteria, threshold, contract name, media spec, audit target…). */
  criteria?: string[];
  threshold?: number;
  contract?: string;
  params?: Record<string, unknown>;
  /** fact_check runs in two stages: the runner fetches the cited sources, then an agent judges the claims. */
  stage?: "sources" | "review";
  sources?: Array<{ url: string; ok: boolean; text: string; claims: string[] }>;
  /** The agent attempt deciding this check (rubric_review, fact_check, contract_conformance by review). */
  reviewAttemptId?: string;
  reviewerAgentId?: string;
  /** rubric_review: score per criterion. */
  scores?: Record<string, number>;
  /** Findings worth showing: broken links, schema errors, unsupported claims, audit violations. */
  details?: string[];
}

/** attempts.checks: the verifier's working state for one attempt. */
export interface AttemptChecks {
  requestedAt: string;
  items: CheckItem[];
}
