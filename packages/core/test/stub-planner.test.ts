import { describe, expect, it } from "vitest";
import { DEMO_TASK_KEY, PlannerNotAvailableError, stubDispatch, stubPlan } from "../src/planner/stub";

describe("stub planner (M0)", () => {
  it("proposes exactly one demo task with a human acceptance gate", () => {
    const plan = stubPlan({ goal: "  Add passkey sign-in  " });
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]).toMatchObject({
      key: DEMO_TASK_KEY,
      type: "plan.decompose",
      contract: { objective: "Add passkey sign-in", acceptance: [{ kind: "human", hard: true }] },
    });
  });

  it("fails closed on an empty goal", () => {
    expect(() => stubPlan({ goal: "   " })).toThrow(PlannerNotAvailableError);
  });

  it("refuses to dispatch", () => {
    expect(() => stubDispatch()).toThrow(/milestone-3/);
  });
});
