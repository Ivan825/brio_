// The scheduler's decisions for one mission (ARCHITECTURE §4.2), as a pure function of its current state. The
// orchestrator applies each action with a conditional update, so running decide() again after a crash, or twice at
// once, is harmless: the state machine is idempotent by construction.
import { footprintsOverlap } from "../leases/overlap";

export type TaskStatus =
  | "pending"
  | "ready"
  | "leased"
  | "running"
  | "verifying"
  | "revise"
  | "done"
  | "failed"
  | "blocked"
  | "cancelled";

export interface SchedTask {
  id: string;
  key: string;
  status: TaskStatus;
  dependsOn: string[];
  /** Footprint paths/globs; empty means "may touch anything" for code tasks. */
  footprint: string[];
  isCode: boolean;
  blockedReason: string | null;
}

export interface SchedSnapshot {
  missionStatus: string;
  tasks: SchedTask[];
  /** Leases held by other tasks (this mission or others in the workspace). */
  heldLeases: Array<{ taskId: string; resource: string }>;
  maxParallel: number;
}

export type Action =
  | { kind: "ready"; taskId: string }
  | { kind: "dispatch"; taskId: string }
  | { kind: "block"; taskId: string; reason: string }
  | { kind: "unblock"; taskId: string }
  | { kind: "mission_done" }
  | { kind: "mission_failed"; reason: string };

const ACTIVE: TaskStatus[] = ["leased", "running", "verifying", "revise"];

/** Lease conflicts are the only blocks the scheduler lifts by itself; other blocks wait for a person. */
export const LEASE_BLOCK = "lease:";

export function decide(s: SchedSnapshot): Action[] {
  if (s.missionStatus !== "running") return [];
  const byId = new Map(s.tasks.map((t) => [t.id, t]));
  const actions: Action[] = [];

  const failed = s.tasks.find((t) => t.status === "failed");
  if (failed) return [{ kind: "mission_failed", reason: `task ${failed.key} failed` }];
  if (s.tasks.length > 0 && s.tasks.every((t) => t.status === "done" || t.status === "cancelled"))
    return [{ kind: "mission_done" }];

  const depsDone = (t: SchedTask) => t.dependsOn.every((d) => byId.get(d)?.status === "done");
  for (const t of s.tasks)
    if (t.status === "pending" && depsDone(t)) actions.push({ kind: "ready", taskId: t.id });

  // Tasks that will be ready this round, plus those already ready or lease-blocked.
  const readyNow = new Set(actions.map((a) => (a.kind === "ready" ? a.taskId : "")));
  // A task in "revise" goes again (it keeps its leases); ready ones and lease-blocked ones may start.
  const candidates = s.tasks.filter(
    (t) =>
      t.status === "revise" ||
      t.status === "ready" ||
      readyNow.has(t.id) ||
      (t.status === "blocked" && t.blockedReason?.startsWith(LEASE_BLOCK)),
  );

  const RUNNING: TaskStatus[] = ["leased", "running", "verifying"];
  let active = s.tasks.filter((t) => RUNNING.includes(t.status)).length;
  const claimed: Array<{ taskId: string; footprint: string[]; any: boolean }> = s.tasks
    .filter((t) => ACTIVE.includes(t.status) && t.isCode)
    .map((t) => ({ taskId: t.id, footprint: t.footprint, any: t.footprint.length === 0 }));
  const held = s.heldLeases.filter(
    (l) => !byId.has(l.taskId) || !ACTIVE.includes(byId.get(l.taskId)?.status ?? "done"),
  );

  for (const t of candidates) {
    if (active >= s.maxParallel) break;
    if (t.isCode) {
      const mine = t.footprint;
      const sibling = claimed.find(
        (c) => c.taskId !== t.id && (c.any || mine.length === 0 || footprintsOverlap(mine, c.footprint)),
      );
      const lease = mine.length === 0 ? held[0] : held.find((l) => footprintsOverlap(mine, [l.resource]));
      const clash = sibling?.taskId ?? lease?.taskId;
      if (clash !== undefined) {
        const other = byId.get(clash)?.key ?? "another task";
        const reason = `${LEASE_BLOCK} waits for ${other} to release files it may also change`;
        if (t.status !== "blocked" || t.blockedReason !== reason)
          actions.push({ kind: "block", taskId: t.id, reason });
        continue;
      }
      if (!claimed.some((c) => c.taskId === t.id))
        claimed.push({ taskId: t.id, footprint: mine, any: mine.length === 0 });
    }
    if (t.status === "blocked") actions.push({ kind: "unblock", taskId: t.id });
    actions.push({ kind: "dispatch", taskId: t.id });
    active++;
  }
  return actions;
}
