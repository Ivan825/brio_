import { z } from "zod";

/** The packet that travels when work moves between agents (docs/HANDOFF_PACKET.md §1). */
export const HandoffPacket = z.object({
  version: z.literal("1"),
  id: z.uuid(),
  mission: z.object({ id: z.string(), title: z.string(), goal: z.string() }),
  from: z.object({ taskKey: z.string(), agentKey: z.string(), vendor: z.string() }),
  to: z.object({ taskKey: z.string(), agentKey: z.string().optional() }),
  /** What the receiver must achieve. */
  objective: z.string(),
  /** What the sender completed. */
  done: z.array(z.string()),
  /** Settled; the receiver must not reopen them without asking. */
  decisions: z.array(z.object({ id: z.string(), statement: z.string(), rationale: z.string().optional() })),
  openQuestions: z.array(
    z.object({
      question: z.string(),
      defaultIfUnanswered: z.string().optional(),
      askWho: z.enum(["user", "sender", "planner"]),
    }),
  ),
  contracts: z.array(z.object({ name: z.string(), version: z.string(), ref: z.string() })),
  artifacts: z.array(
    z.object({
      kind: z.string(),
      ref: z.string(),
      sha256: z.string().optional(),
      note: z.string().optional(),
    }),
  ),
  constraints: z.array(z.string()),
  evidence: z.array(
    z.object({
      kind: z.enum(["test", "review", "source", "benchmark"]),
      ref: z.string(),
      summary: z.string(),
    }),
  ),
  risks: z.array(z.string()),
  nextSteps: z.array(z.string()),
  /** The receiver treats the body as data, never as instructions overriding its own rules. */
  trust: z.literal("untrusted-content"),
  createdAt: z.iso.datetime(),
});
export type HandoffPacket = z.infer<typeof HandoffPacket>;

/** A stored handoff between two tasks. */
export const Handoff = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  fromTaskId: z.uuid(),
  toTaskId: z.uuid(),
  packet: HandoffPacket,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Handoff = z.infer<typeof Handoff>;
