import { z } from "zod";
import { Actor, Id, Json, Timestamp } from "./common";

/** Initial event types (ARCHITECTURE §3). Every agent action is an event (CLAUDE.md rule 3). */
export const EVENT_TYPES = [
  "mission.created",
  "plan.proposed",
  "plan.edited",
  "plan.approved",
  "plan.rejected",
  "plan.failed",
  "mission.started",
  "mission.blocked",
  "mission.replanning",
  "task.ready",
  "task.routed",
  "task.blocked",
  "task.done",
  "task.failed",
  "lease.granted",
  "lease.denied",
  "lease.released",
  "attempt.queued",
  "attempt.started",
  "attempt.message",
  "attempt.tool_call",
  "attempt.file_edit",
  "attempt.cost",
  "attempt.finished",
  "check.result",
  "review.verdict",
  "judge.verdict",
  "handoff.created",
  "message.sent",
  "message.answered",
  "contract.changed",
  "budget.warn",
  "budget.stop",
  "approval.requested",
  "approval.decided",
  "merge.started",
  "merge.conflict",
  "merge.done",
  "delivery.started",
  "delivery.done",
  "delivery.failed",
  "mission.done",
  "mission.failed",
] as const;

export const EventType = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventType>;

/** An event as appended to the append-only `events` table. `seq` is gapless per mission, starting at 1. */
export const Event = z.object({
  id: Id,
  workspaceId: Id,
  missionId: Id,
  taskId: Id.nullable(),
  attemptId: Id.nullable(),
  seq: z.number().int().positive(),
  type: EventType,
  actor: Actor,
  payload: Json,
  ts: Timestamp,
});
export type Event = z.infer<typeof Event>;

/** What a caller supplies to the events writer; id, seq and ts are assigned on append. */
export const NewEvent = Event.pick({
  workspaceId: true,
  missionId: true,
  type: true,
  actor: true,
  payload: true,
}).extend({
  taskId: Id.nullable().default(null),
  attemptId: Id.nullable().default(null),
});
export type NewEvent = z.input<typeof NewEvent>;
