import { describe, expect, it } from "vitest";
import {
  applyOutcome,
  applyRating,
  type Candidate,
  decay,
  defaultMode,
  eloUpdate,
  freshScore,
  inheritPrior,
  type LearnedTask,
  passRate,
  type RouteAgent,
  rank,
  routeLearned,
  type SyntheticAgent,
  sampleBeta,
  seeded,
  simulate,
  trueUtility,
} from "../src/index";

const now = new Date("2026-10-23T12:00:00Z");
const day = 86_400_000;

describe("scoreboard maths", () => {
  it("counts pass, revise and fail into the posterior and averages cost and latency", () => {
    let s = freshScore(now);
    s = applyOutcome(s, { outcome: "pass", costUsd: 0.4, seconds: 60, now });
    s = applyOutcome(s, { outcome: "revise", costUsd: 0.2, seconds: 30, now });
    s = applyOutcome(s, { outcome: "fail", costUsd: 0.2, seconds: 30, now });
    expect(s).toMatchObject({ alpha: 2, beta: 2.5, n: 3 });
    expect(s.avgCost).toBeCloseTo(0.4 + 0.2 * (0.2 - 0.4) + 0.2 * (0.2 - 0.36), 6);
    expect(applyRating(s, 1, now).alpha).toBe(2.5);
    expect(applyRating(s, -1, now).beta).toBe(3.5);
  });

  it("decays old evidence with a 60-day half-life", () => {
    const s = { ...freshScore(now), alpha: 21, beta: 1, elo: 1400 };
    const later = decay(s, new Date(now.getTime() + 60 * day));
    expect(later.alpha).toBeCloseTo(11, 6);
    expect(later.elo).toBeCloseTo(1300, 6);
    expect(decay(s, now)).toBe(s);
  });

  it("updates Elo symmetrically and gives a new model its predecessor's rate at weight 5", () => {
    const [a, b] = eloUpdate(1200, 1200, "a");
    expect(a).toBe(1212);
    expect(b).toBe(1188);
    expect(eloUpdate(1200, 1200, "tie")).toEqual([1200, 1200]);
    const old = { ...freshScore(now), alpha: 81, beta: 21, n: 100 };
    const p = inheritPrior(old, now);
    expect(passRate(p)).toBeCloseTo((1 + (81 / 102) * 5) / 7, 6);
    expect(p.alpha + p.beta).toBeCloseTo(7, 6);
    expect(p.n).toBe(0);
  });

  it("samples Beta distributions with the right mean", () => {
    const rng = seeded(42);
    const xs = Array.from({ length: 4000 }, () => sampleBeta(8, 2, rng));
    expect(xs.reduce((s, x) => s + x, 0) / xs.length).toBeCloseTo(0.8, 1);
    expect(Math.min(...xs)).toBeGreaterThan(0);
    expect(Math.max(...xs)).toBeLessThan(1);
  });
});

describe("routing simulation (BUILD_PLAN M4 acceptance)", () => {
  // One synthetic team per priority, each with a clearly best agent by that priority's utility (gap ≥ 0.15). Agents
  // closer than that are near-equals that Thompson sampling keeps exploring by design (D-51).
  const teams: Record<"balanced" | "quality" | "cheap" | "fast", SyntheticAgent[]> = {
    balanced: [
      { id: "best", vendor: "a", passRate: 0.85, costUsd: 0.15, latencyS: 90 },
      { id: "pricey", vendor: "b", passRate: 0.9, costUsd: 0.9, latencyS: 150 },
      { id: "weak", vendor: "c", passRate: 0.5, costUsd: 0.05, latencyS: 60 },
      { id: "slow", vendor: "d", passRate: 0.65, costUsd: 0.3, latencyS: 300 },
    ],
    quality: [
      { id: "best", vendor: "a", passRate: 0.95, costUsd: 0.8, latencyS: 150 },
      { id: "cheap", vendor: "b", passRate: 0.7, costUsd: 0.1, latencyS: 90 },
      { id: "weak", vendor: "c", passRate: 0.5, costUsd: 0.05, latencyS: 60 },
      { id: "mid", vendor: "d", passRate: 0.65, costUsd: 0.3, latencyS: 200 },
    ],
    cheap: [
      { id: "best", vendor: "a", passRate: 0.8, costUsd: 0.05, latencyS: 90 },
      { id: "pricey", vendor: "b", passRate: 0.95, costUsd: 1, latencyS: 120 },
      { id: "weak", vendor: "c", passRate: 0.45, costUsd: 0.04, latencyS: 60 },
      { id: "mid", vendor: "d", passRate: 0.7, costUsd: 0.4, latencyS: 200 },
    ],
    fast: [
      { id: "best", vendor: "a", passRate: 0.8, costUsd: 0.2, latencyS: 30 },
      { id: "slow-strong", vendor: "b", passRate: 0.9, costUsd: 0.2, latencyS: 400 },
      { id: "weak", vendor: "c", passRate: 0.45, costUsd: 0.05, latencyS: 40 },
      { id: "mid", vendor: "d", passRate: 0.7, costUsd: 0.3, latencyS: 200 },
    ],
  };

  for (const [priority, team] of Object.entries(teams) as [keyof typeof teams, SyntheticAgent[]][]) {
    it(`converges to the best-utility agent within 50 tasks (${priority})`, () => {
      const u = trueUtility(team, priority);
      const ranked = Object.entries(u).sort((a, b) => b[1] - a[1]);
      expect(ranked[0]![0]).toBe("best");
      expect(ranked[0]![1] - ranked[1]![1]).toBeGreaterThanOrEqual(0.15);
      const seeds = 200;
      let identified = 0;
      let exploiting = 0;
      for (let seed = 1; seed <= seeds; seed++) {
        const r = simulate(team, { tasks: 50, priority, seed });
        // What the router has learned: its estimate ranks the best agent first.
        const learned = trueUtility(
          team.map((a) => ({ ...a, passRate: passRate(r.scores[a.id]!) })),
          priority,
        );
        if (Object.entries(learned).sort((a, b) => b[1] - a[1])[0]![0] === "best") identified++;
        // What it does about it: the best agent is the one it picks most over tasks 41–50.
        const counts = new Map<string, number>();
        for (const p of r.picks.slice(-10)) counts.set(p, (counts.get(p) ?? 0) + 1);
        if ([...counts].sort((a, b) => b[1] - a[1])[0]![0] === "best") exploiting++;
      }
      expect(identified / seeds).toBeGreaterThanOrEqual(0.9);
      expect(exploiting / seeds).toBeGreaterThanOrEqual(0.85);
    });
  }
});

describe("router", () => {
  const agent = (id: string, vendor: string, over: Partial<RouteAgent> = {}): RouteAgent => ({
    id,
    name: id,
    model: "m",
    route: "api",
    vendor,
    taskTypes: [
      "code.feature",
      "write.doc",
      "design.api_contract",
      "write.summary",
      "review.rubric",
      "research.deep_report",
    ],
    local: false,
    runnable: true,
    ...over,
  });
  const cand = (a: RouteAgent, over: Partial<Candidate> = {}): Candidate => ({
    agent: a,
    score: freshScore(now),
    healthy: true,
    estUsd: 0.2,
    ...over,
  });
  const task = (over: Partial<LearnedTask> = {}): LearnedTask => ({
    key: "t",
    type: "code.feature",
    sensitivity: "internal",
    pinnedAgentId: null,
    mode: "single",
    hasTests: true,
    modeExplicit: false,
    ...over,
  });
  const team = [
    cand(agent("claude", "anthropic")),
    cand(agent("gpt", "openai")),
    cand(agent("gemini", "gemini")),
  ];
  const opts = (over = {}) => ({ priority: "balanced" as const, rng: seeded(7), everyone: team, ...over });

  it("chooses modes by the default rules", () => {
    expect(defaultMode(task(), "balanced")).toBe("best_of_n");
    expect(defaultMode(task({ hasTests: false }), "balanced")).toBe("maker_checker");
    expect(defaultMode(task({ type: "design.api_contract" }), "balanced")).toBe("debate");
    expect(defaultMode(task({ type: "research.deep_report" }), "balanced")).toBe("ensemble");
    expect(defaultMode(task({ type: "write.summary" }), "balanced")).toBe("cascade");
    expect(defaultMode(task(), "fast")).toBe("single");
    expect(defaultMode(task({ type: "write.summary" }), "cheap")).toBe("cascade");
  });

  it("staffs best-of-n and debate from different vendors, with an independent judge", () => {
    const bon = routeLearned(task(), team, opts());
    expect(bon.ok && bon.mode).toBe("best_of_n");
    if (bon.ok) {
      const vendors = bon.agents.map((a) => team.find((c) => c.agent.id === a.agentId)?.agent.vendor);
      expect(new Set(vendors).size).toBe(bon.agents.length);
      expect(bon.rationale).toMatch(/^best of 2: /);
    }
    const debate = routeLearned(task({ type: "design.api_contract" }), team, opts());
    expect(debate.ok && debate.mode).toBe("debate");
    if (debate.ok) {
      const [a, b, judge] = debate.agents;
      expect(judge?.role).toBe("judge");
      expect([a?.agentId, b?.agentId]).not.toContain(judge?.agentId);
    }
  });

  it("never lets a maker check itself, and degrades when there is only one agent", () => {
    const mc = routeLearned(task({ hasTests: false }), team, opts());
    expect(mc.ok && mc.agents.map((a) => a.role)).toEqual(["maker", "checker"]);
    if (mc.ok) expect(mc.agents[0]?.agentId).not.toBe(mc.agents[1]?.agentId);
    const solo = routeLearned(task(), [team[0] as Candidate], opts({ everyone: [team[0]] }));
    expect(solo).toMatchObject({
      ok: true,
      mode: "single",
      degraded: "best of n needs 2+ agents; running single",
    });
  });

  it("filters out unhealthy connectors and agents over the remaining budget, and explains", () => {
    const sick = [cand(agent("a", "x"), { healthy: false })];
    expect(routeLearned(task(), sick, opts({ everyone: sick }))).toEqual({
      ok: false,
      reason: "the agents that can do code.feature have failing connectors",
    });
    const pricey = [cand(agent("a", "x"), { estUsd: 5 })];
    expect(routeLearned(task(), pricey, opts({ everyone: pricey, remainingUsd: 1 }))).toEqual({
      ok: false,
      reason: "no agent fits the remaining budget ($1.00)",
    });
    const r = routeLearned(task({ modeExplicit: true }), team, opts());
    expect(r.ok && r.rationale).toMatch(/chosen: no history on code.feature yet, exploring/);
  });

  it("writes the rationale from the scoreboard", () => {
    const strong = cand(agent("codex", "openai"), {
      score: { ...freshScore(now), alpha: 34, beta: 8, n: 41, avgCost: 0.31 },
    });
    const peer = cand(agent("claude-code", "anthropic"), {
      score: { ...freshScore(now), alpha: 33, beta: 8, n: 40, avgCost: 0.55 },
    });
    const r = routeLearned(task({ modeExplicit: true }), [strong, peer], {
      priority: "cheap",
      rng: seeded(3),
      everyone: [strong, peer],
    });
    expect(r.ok && r.rationale).toBe(
      "codex chosen: 81% pass rate on code.feature (n=41), $0.31 avg, beats claude-code on cost at similar quality",
    );
  });

  it("ranks by utility: samples quality, subtracts cost and latency", () => {
    const ranked = rank(team, "balanced", seeded(1));
    expect(ranked).toHaveLength(3);
    expect(ranked[0]!.utility).toBeGreaterThanOrEqual(ranked[1]!.utility);
  });
});
