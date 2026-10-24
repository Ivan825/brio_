// The local runner protocol (BUILD_PLAN M8): JSON messages over one WebSocket the runner opens to the API. The API sends
// jobs (attempts, their command checks, merges, deliveries) and cancels; the runner sends events as work happens and
// each job's outcome, which the API records exactly as the cloud runner records its own. Bytes travel as base64.
import type { CheckItem, Dispatch, RunResult } from "@brio/adapters";
import type { Actor, EventType } from "@brio/schema";
import type { MergeCheck, MergeInput, MergeOutcome } from "../integrate";
import type { CollectedResult, MergeConflict } from "../worktree";

/** The WebSocket subprotocol a runner asks for; its token travels beside it in the handshake. */
export const RUNNER_SUBPROTOCOL = "brio-runner";

export const PROTOCOL_VERSION = 1;

export interface RunnerCapabilities {
  clis: Array<{ key: string; version: string }>;
  docker: boolean;
  os: string;
  version: string;
}

export interface AttemptRef {
  id: string;
  workspaceId: string;
  taskId: string;
}

/** API → runner. */
export type ServerMessage =
  | { t: "welcome"; runnerId: string; name: string; mode: "docker" | "host" }
  | { t: "attempt"; attempt: AttemptRef; dispatch: Dispatch }
  | {
      t: "checks";
      attemptId: string;
      missionId: string;
      taskKey: string;
      branch: string;
      repo: { url: string; branch: string | null } | null;
      items: CheckItem[];
    }
  | { t: "merge"; row: MergeInput; commands: string[] }
  | { t: "deliver"; deliveryId: string; repo: string; branch: string; commit: string }
  | { t: "list_files"; requestId: string; repo: { url: string; branch: string | null } }
  /** A budget reached ("budget…") ends the attempt as limit_exceeded; anything else cancels it. */
  | { t: "cancel"; attemptId: string; reason?: string }
  | { t: "error"; message: string };

/** A produced file or changed file's bytes, as base64. */
export type WireFile = { b64: string };

export type WireResult = Omit<RunResult, "files" | "raw"> & {
  files?: Array<Omit<NonNullable<RunResult["files"]>[number], "bytes"> & WireFile>;
};

export type WireCollected = Omit<CollectedResult, "diff" | "files"> & {
  diff: string;
  files: Array<Omit<CollectedResult["files"][number], "content"> & { content?: string }>;
};

export type WireMergeOutcome =
  | { status: "conflict"; conflict: MergeConflict }
  | { status: "error"; error: string }
  | {
      status: "passed" | "failed";
      branch: string;
      commit: string;
      base: string;
      diff: string;
      checks: MergeCheck[];
    };

/** runner → API. */
export type RunnerMessage =
  | { t: "hello"; token: string; protocol: number; capabilities: RunnerCapabilities }
  | { t: "event"; attemptId: string; type: EventType; payload: Record<string, unknown>; actor?: Actor }
  | { t: "vendor_run"; attemptId: string; id: string }
  | { t: "ready"; attemptId: string; branch: string; sandbox: string }
  | {
      t: "attempt_done";
      attemptId: string;
      result: WireResult;
      worktree: { branch: string; base: string } | null;
      collected: WireCollected | null;
    }
  | { t: "check_result"; attemptId: string; item: CheckItem }
  | { t: "checks_done"; attemptId: string }
  | { t: "merge_done"; integrationId: string; outcome: WireMergeOutcome }
  | { t: "delivery_done"; deliveryId: string; ok: boolean; error?: string }
  | { t: "files"; requestId: string; files: string[]; error?: string };

export const b64 = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64");
export const unb64 = (s: string) => Buffer.from(s, "base64");

export function resultToWire(r: RunResult): WireResult {
  const { files, raw: _raw, ...rest } = r;
  return {
    ...rest,
    ...(files ? { files: files.map(({ bytes, ...f }) => ({ ...f, b64: b64(bytes) })) } : {}),
  };
}

export function resultFromWire(w: WireResult): RunResult {
  const { files, ...rest } = w;
  return {
    ...rest,
    ...(files ? { files: files.map(({ b64: data, ...f }) => ({ ...f, bytes: unb64(data) })) } : {}),
  };
}

export function collectedToWire(c: CollectedResult): WireCollected {
  return {
    ...c,
    diff: b64(c.diff),
    files: c.files.map(({ content, ...f }) => ({ ...f, ...(content ? { content: b64(content) } : {}) })),
  };
}

export function collectedFromWire(w: WireCollected): CollectedResult {
  return {
    ...w,
    diff: unb64(w.diff),
    files: w.files.map(({ content, ...f }) => ({ ...f, ...(content ? { content: unb64(content) } : {}) })),
  };
}

export function mergeToWire(o: MergeOutcome): WireMergeOutcome {
  switch (o.status) {
    case "conflict":
    case "error":
      return o;
    default:
      return { ...o, diff: b64(o.diff) };
  }
}

export function mergeFromWire(o: WireMergeOutcome): MergeOutcome {
  switch (o.status) {
    case "conflict":
    case "error":
      return o;
    default:
      return { ...o, diff: unb64(o.diff) };
  }
}
