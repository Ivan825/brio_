// TODO(milestone-3): replace with the real planner (docs/ROUTING_AND_QUALITY.md §2): model decomposition,
// contract-first pass, lease inference, estimates and plan lint.
//
// Until then this stub fails closed. It never invents a multi-task plan: it always proposes exactly one demo task that
// restates the goal, gated by a human acceptance check, and it refuses to dispatch anything.
import { PlanGraph, type PlanGraph as PlanGraphType } from "@brio/schema";

export const STUB_PLANNER_ID = "stub-planner@m0";
export const DEMO_TASK_KEY = "demo.review-goal";

export class PlannerNotAvailableError extends Error {
  override name = "PlannerNotAvailableError";
}

export interface StubPlanInput {
  goal: string;
}

/** Proposes the single demo task for a mission goal. Throws for anything it cannot represent honestly. */
export function stubPlan({ goal }: StubPlanInput): PlanGraphType {
  const trimmed = goal.trim();
  if (!trimmed) throw new PlannerNotAvailableError("a mission needs a goal");
  return PlanGraph.parse({
    tasks: [
      {
        key: DEMO_TASK_KEY,
        type: "plan.decompose",
        title: "Review the goal and approve a plan",
        contract: {
          objective: trimmed,
          inputs: [{ kind: "text", ref: "mission.goal" }],
          outputs: [{ kind: "report", description: "A reviewed plan for this goal" }],
          acceptance: [{ kind: "human", hard: true }],
          constraints: ["Stub planner (M0): decomposition, routing and dispatch arrive in M3."],
          sensitivity: "internal",
        },
        dependsOn: [],
        suggestedMode: "single",
      },
    ],
    assumptions: ["Planned by the M0 stub planner: one task, no agents dispatched."],
    questions: [],
  });
}

/** Dispatch is not available before M3; refuse rather than pretend. */
export function stubDispatch(): never {
  throw new PlannerNotAvailableError("task dispatch arrives in M3 (TODO(milestone-3))");
}
