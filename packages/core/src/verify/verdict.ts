// Verdict logic (ROUTING §4.2): from a result's checklist and the task's history, what happens next. Pure.
//   any hard check failed → revise with the failures (same agent, twice) → reroute to the next-best agent (once) → fail
//   any hard check still open → wait
//   every hard check passed → pass (soft failures become open issues in the mission report)

export const MAX_REVISIONS = 2;
export const MAX_REROUTES = 1;

export type CheckState = "pending" | "running" | "passed" | "failed" | "needs_human";

export interface VerdictItem {
  kind: string;
  hard: boolean;
  status: CheckState;
  summary?: string;
}

export interface VerdictInput {
  items: VerdictItem[];
  /** Revise loops already used on this task. */
  revisions: number;
  /** Times the task already moved to another agent. */
  reroutes: number;
  maxRevisions?: number;
  maxReroutes?: number;
}

export type Verdict =
  | { kind: "wait"; waitingOn: string[] }
  | { kind: "pass"; softFailures: string[] }
  | { kind: "revise" | "reroute" | "fail"; reasons: string[] };

const reason = (i: VerdictItem) => `${i.kind}: ${i.summary ?? "failed"}`;

export function verdict(input: VerdictInput): Verdict {
  const hard = input.items.filter((i) => i.hard);
  const failed = hard.filter((i) => i.status === "failed");
  if (failed.length) {
    const reasons = failed.map(reason);
    if (input.revisions < (input.maxRevisions ?? MAX_REVISIONS)) return { kind: "revise", reasons };
    if (input.reroutes < (input.maxReroutes ?? MAX_REROUTES)) return { kind: "reroute", reasons };
    return { kind: "fail", reasons };
  }
  const open = hard.filter((i) => i.status !== "passed");
  if (open.length) return { kind: "wait", waitingOn: open.map((i) => i.kind) };
  return {
    kind: "pass",
    softFailures: input.items.filter((i) => !i.hard && i.status === "failed").map(reason),
  };
}
