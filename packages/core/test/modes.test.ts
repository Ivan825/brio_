import { describe, expect, it } from "vitest";
import { type ModeAttempt, type ModeState, nextStep, parseJudgment, parseVerdict } from "../src/index";

let t = 0;
const att = (over: Partial<ModeAttempt> & Pick<ModeAttempt, "id" | "agentId">): ModeAttempt => ({
  role: "candidate",
  status: "succeeded",
  checks: "passed",
  purpose: "make",
  of: [],
  step: 0,
  costUsd: 0.1,
  createdAt: t++,
  ...over,
});
const state = (
  mode: ModeState["mode"],
  agents: ModeState["agents"],
  attempts: ModeAttempt[] = [],
): ModeState => ({
  mode,
  agents,
  attempts,
  maxRevisions: 2,
});

describe("best of n", () => {
  const agents = [
    { agentId: "a", role: "candidate" as const },
    { agentId: "b", role: "candidate" as const },
    { agentId: "j", role: "judge" as const },
  ];

  it("starts every candidate, waits for their checks, then judges in both orders", () => {
    expect(nextStep(state("best_of_n", agents)).map((x) => x.kind === "dispatch" && x.agentId)).toEqual([
      "a",
      "b",
    ]);
    const made = [att({ id: "A", agentId: "a" }), att({ id: "B", agentId: "b", checks: "pending" })];
    expect(nextStep(state("best_of_n", agents, made))).toEqual([]);
    const both = [att({ id: "A", agentId: "a" }), att({ id: "B", agentId: "b" })];
    const judges = nextStep(state("best_of_n", agents, both));
    expect(judges).toEqual([
      { kind: "dispatch", role: "judge", agentId: "j", purpose: "judge", of: ["A", "B"], step: 0 },
      { kind: "dispatch", role: "judge", agentId: "j", purpose: "judge", of: ["B", "A"], step: 0 },
    ]);
  });

  it("accepts the judges' agreed winner; a disagreement goes to the likelier-right agent (cheaper only on a cheap mission)", () => {
    const both = [att({ id: "A", agentId: "a", costUsd: 0.3 }), att({ id: "B", agentId: "b", costUsd: 0.1 })];
    const agree = [
      ...both,
      att({ id: "J1", agentId: "j", role: "judge", purpose: "judge", of: ["A", "B"], winner: "A" }),
      att({ id: "J2", agentId: "j", role: "judge", purpose: "judge", of: ["B", "A"], winner: "A" }),
    ];
    expect(nextStep(state("best_of_n", agents, agree))).toEqual([
      { kind: "judged", winner: "A", loser: "B", tie: false },
      { kind: "accept", attemptId: "A", note: "best of 2: chosen by the judge" },
    ]);
    const split = [
      ...both,
      att({ id: "J1", agentId: "j", role: "judge", purpose: "judge", of: ["A", "B"], winner: "A" }),
      att({ id: "J2", agentId: "j", role: "judge", purpose: "judge", of: ["B", "A"], winner: "B" }),
    ];
    // No scores yet: equal priors, so the cheaper result.
    expect(nextStep(state("best_of_n", agents, split))[1]).toMatchObject({ kind: "accept", attemptId: "B" });
    // The scoreboard says agent a passes far more often: its result wins the tie, though it cost more.
    const informed = { ...state("best_of_n", agents, split), priors: { a: 0.9, b: 0.4 } };
    expect(nextStep(informed)[1]).toMatchObject({ kind: "accept", attemptId: "A" });
    // A mission on the cheap priority keeps the cheaper result.
    expect(nextStep({ ...informed, preferCheaper: true })[1]).toMatchObject({
      kind: "accept",
      attemptId: "B",
    });
  });

  it("tests outrank the judge: one passing candidate wins without judging; none passing fails", () => {
    const one = [att({ id: "A", agentId: "a", checks: "failed" }), att({ id: "B", agentId: "b" })];
    expect(nextStep(state("best_of_n", agents, one))).toEqual([
      { kind: "accept", attemptId: "B", note: "the only candidate that passed its checks" },
    ]);
    const none = [
      att({ id: "A", agentId: "a", checks: "failed" }),
      att({ id: "B", agentId: "b", status: "failed", checks: "none" }),
    ];
    expect(nextStep(state("best_of_n", agents, none))[0]).toMatchObject({ kind: "fail" });
  });
});

describe("maker–checker", () => {
  const agents = [
    { agentId: "m", role: "maker" as const },
    { agentId: "c", role: "checker" as const },
  ];
  it("makes, reviews, revises on request with the reasons, and accepts on pass", () => {
    expect(nextStep(state("maker_checker", agents))[0]).toMatchObject({
      kind: "dispatch",
      agentId: "m",
      purpose: "make",
    });
    const made = [att({ id: "M1", agentId: "m", role: "maker" })];
    expect(nextStep(state("maker_checker", agents, made))[0]).toMatchObject({
      kind: "dispatch",
      agentId: "c",
      purpose: "review",
      of: ["M1"],
    });
    const asked = [
      ...made,
      att({
        id: "R1",
        agentId: "c",
        role: "checker",
        purpose: "review",
        of: ["M1"],
        verdict: "revise",
        reasons: "add tests",
        checks: "none",
      }),
    ];
    expect(nextStep(state("maker_checker", agents, asked))[0]).toMatchObject({
      kind: "dispatch",
      agentId: "m",
      purpose: "revise",
      feedback: "The checker asked for changes: add tests",
    });
    const fixed = [
      ...asked,
      att({ id: "M2", agentId: "m", role: "maker", purpose: "revise", of: ["M1"] }),
      att({
        id: "R2",
        agentId: "c",
        role: "checker",
        purpose: "review",
        of: ["M2"],
        verdict: "pass",
        checks: "none",
      }),
    ];
    expect(nextStep(state("maker_checker", agents, fixed))).toEqual([
      { kind: "accept", attemptId: "M2", note: "approved by the checker" },
    ]);
  });

  it("stops after the revision limit", () => {
    const rounds: ModeAttempt[] = [];
    for (let i = 1; i <= 3; i++) {
      rounds.push(att({ id: `M${i}`, agentId: "m", role: "maker", purpose: i === 1 ? "make" : "revise" }));
      rounds.push(
        att({
          id: `R${i}`,
          agentId: "c",
          role: "checker",
          purpose: "review",
          of: [`M${i}`],
          verdict: "revise",
          reasons: "no",
        }),
      );
    }
    expect(nextStep(state("maker_checker", agents, rounds))[0]).toMatchObject({ kind: "fail" });
  });
});

describe("ensemble, debate, cascade, pipeline", () => {
  it("ensemble: all members, then one merge, accepted when it passes", () => {
    const agents = [
      { agentId: "a", role: "candidate" as const },
      { agentId: "b", role: "candidate" as const },
      { agentId: "m", role: "merger" as const },
    ];
    const made = [att({ id: "A", agentId: "a" }), att({ id: "B", agentId: "b", status: "failed" })];
    expect(nextStep(state("ensemble", agents, made))).toEqual([
      { kind: "dispatch", role: "merger", agentId: "m", purpose: "merge", of: ["A"], step: 0 },
    ]);
    expect(
      nextStep(
        state("ensemble", agents, [
          ...made,
          att({ id: "X", agentId: "m", role: "merger", purpose: "merge", of: ["A"] }),
        ]),
      ),
    ).toEqual([{ kind: "accept", attemptId: "X", note: "merged from 1 results" }]);
  });

  it("debate: two proposals, judged both ways, then merged by the judge", () => {
    const agents = [
      { agentId: "a", role: "candidate" as const },
      { agentId: "b", role: "candidate" as const },
      { agentId: "j", role: "judge" as const },
      { agentId: "j", role: "merger" as const },
    ];
    const proposals = [att({ id: "A", agentId: "a" }), att({ id: "B", agentId: "b" })];
    expect(nextStep(state("debate", agents, proposals)).map((x) => x.kind)).toEqual(["dispatch", "dispatch"]);
    const judged = [
      ...proposals,
      att({ id: "J1", agentId: "j", role: "judge", purpose: "judge", of: ["A", "B"], winner: "B" }),
      att({ id: "J2", agentId: "j", role: "judge", purpose: "judge", of: ["B", "A"], winner: "B" }),
    ];
    expect(nextStep(state("debate", agents, judged))[1]).toMatchObject({
      kind: "dispatch",
      role: "merger",
      of: ["B", "A"],
    });
    const merged = [
      ...judged,
      att({ id: "X", agentId: "j", role: "merger", purpose: "merge", of: ["B", "A"] }),
    ];
    expect(nextStep(state("debate", agents, merged))[1]).toEqual({
      kind: "accept",
      attemptId: "X",
      note: "the judge picked and merged the proposals",
    });
  });

  it("cascade: cheapest first, escalate only on a failed check", () => {
    const agents = [
      { agentId: "cheap", role: "maker" as const },
      { agentId: "mid", role: "maker" as const },
      { agentId: "top", role: "maker" as const },
    ];
    const failed = [att({ id: "C", agentId: "cheap", role: "maker", checks: "failed" })];
    expect(nextStep(state("cascade", agents, failed))[0]).toMatchObject({
      kind: "dispatch",
      agentId: "mid",
      step: 1,
    });
    const passed = [...failed, att({ id: "M", agentId: "mid", role: "maker", step: 1 })];
    expect(nextStep(state("cascade", agents, passed))).toEqual([
      { kind: "accept", attemptId: "M", note: "escalated to step 2" },
    ]);
    expect(
      nextStep(state("cascade", agents, [att({ id: "C", agentId: "cheap", role: "maker" })]))[0],
    ).toMatchObject({ kind: "accept", note: "the cheapest agent passed" });
  });

  it("pipeline: each step feeds the next; the last one's checks decide", () => {
    const agents = [
      { agentId: "draft", role: "maker" as const },
      { agentId: "edit", role: "maker" as const },
    ];
    expect(
      nextStep(
        state("pipeline", agents, [att({ id: "D", agentId: "draft", role: "maker", checks: "failed" })]),
      )[0],
    ).toMatchObject({ kind: "dispatch", agentId: "edit", of: ["D"], step: 1 });
    expect(
      nextStep(
        state("pipeline", agents, [
          att({ id: "D", agentId: "draft", role: "maker" }),
          att({ id: "E", agentId: "edit", role: "maker", step: 1 }),
        ]),
      ),
    ).toEqual([{ kind: "accept", attemptId: "E", note: "pipeline of 2 steps" }]);
  });
});

describe("reading reviewers and judges", () => {
  it("parses verdicts and judgments, and rejects anything else", () => {
    expect(parseVerdict('```json\n{"verdict":"revise","reasons":["a","b"]}\n```')).toEqual({
      verdict: "revise",
      reasons: "a; b",
    });
    expect(parseVerdict("looks good to me")).toBeNull();
    expect(parseJudgment('{"winner":"b","reasons":"clearer"}')).toEqual({ winner: "B", reasons: "clearer" });
    expect(parseJudgment('{"winner":"both"}')).toBeNull();
  });
});
