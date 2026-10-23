import type { PlanGraph, PlannedTask } from "@brio/schema";
import { describe, expect, it } from "vitest";
import {
  ancestors,
  applyPlanEdit,
  buildHandoff,
  choosePlanner,
  decide,
  extractJson,
  findCycle,
  footprintsOverlap,
  LEASE_BLOCK,
  lintPlan,
  PlanEditError,
  parsePlan,
  patternsOverlap,
  plannerInstructions,
  type RouteAgent,
  type SchedTask,
  section,
  staticRoute,
} from "../src/index";

const task = (key: string, over: Partial<PlannedTask> = {}, deps: string[] = []): PlannedTask => ({
  key,
  type: "code.feature",
  title: key,
  contract: {
    objective: `do ${key}`,
    inputs: [],
    outputs: [{ kind: "diff", description: key }],
    acceptance: [{ kind: "tests", command: "pnpm test", hard: true }],
    constraints: [],
    expectedFootprint: { paths: [`src/${key}/**`] },
    sensitivity: "internal",
  },
  dependsOn: deps,
  suggestedMode: "single",
  ...over,
});
const plan = (...tasks: PlannedTask[]): PlanGraph => ({ tasks, assumptions: [], questions: [] });

describe("footprint overlap", () => {
  it("is conservative about paths, directories and globs", () => {
    expect(patternsOverlap("src/a.ts", "src/a.ts")).toBe(true);
    expect(patternsOverlap("src/a.ts", "src/b.ts")).toBe(false);
    expect(patternsOverlap("src/api/**", "src/api/routes/x.ts")).toBe(true);
    expect(patternsOverlap("src/api", "src/api/x.ts")).toBe(true);
    expect(patternsOverlap("src/api/**", "src/web/**")).toBe(false);
    expect(patternsOverlap("**/*.ts", "docs/x.md")).toBe(true); // a root glob may touch anything
    expect(patternsOverlap("./src//a/", "src/a")).toBe(true);
    expect(footprintsOverlap(["src/a/**"], ["src/b/**", "src/a/x.ts"])).toBe(true);
  });
});

describe("plan lint", () => {
  it("finds cycles, unknown dependencies and missing checks", () => {
    const g = plan(task("a", {}, ["b"]), task("b", {}, ["a"]), task("c", {}, ["zzz"]));
    expect(findCycle(g)).toEqual(["a", "b", "a"]);
    const r = lintPlan(g);
    expect(r.errors.map((e) => e.message)).toEqual(
      expect.arrayContaining(["depends on unknown task zzz", "dependency cycle: a → b → a"]),
    );
    const noCmd = task("d");
    noCmd.contract.acceptance = [{ kind: "tests", hard: true }];
    expect(lintPlan(plan(noCmd)).errors[0]?.message).toBe("the tests check needs a command");
  });

  it("makes contract consumers wait for the contract's producer", () => {
    const contract = task("contract.api", { type: "design.api_contract" });
    const consumer = task("web");
    consumer.contract.inputs = [{ kind: "contract", ref: "contract.api" }];
    const r = lintPlan(plan(contract, consumer));
    expect(r.errors).toEqual([]);
    expect(r.graph.tasks[1]?.dependsOn).toEqual(["contract.api"]);
    expect(r.fixes[0]?.message).toMatch(/waits for contract.api/);
    const orphan = task("x");
    orphan.contract.inputs = [{ kind: "contract", ref: "nope" }];
    expect(lintPlan(plan(orphan)).errors[0]?.message).toMatch(/no task defines/);
  });

  it("serialises parallel code tasks that may touch the same files, and leaves disjoint ones parallel", () => {
    const a = task("a", {
      contract: { ...task("a").contract, expectedFootprint: { paths: ["src/auth/**"] } },
    });
    const b = task("b", {
      contract: { ...task("b").contract, expectedFootprint: { paths: ["src/auth/login.ts"] } },
    });
    const c = task("c", { contract: { ...task("c").contract, expectedFootprint: { paths: ["docs/**"] } } });
    const r = lintPlan(plan(a, b, c));
    expect(r.graph.tasks.find((t) => t.key === "b")?.dependsOn).toEqual(["a"]);
    expect(r.graph.tasks.find((t) => t.key === "c")?.dependsOn).toEqual([]);
    expect(ancestors(r.graph, "b")).toEqual(new Set(["a"]));
  });

  it("estimates cost and the critical path, and flags a budget overrun", () => {
    const g = plan(
      task("a", { estimate: { usd: 1, minutes: 5 } }),
      task(
        "b",
        {
          estimate: { usd: 2, minutes: 10 },
          contract: { ...task("b").contract, expectedFootprint: { paths: ["lib/**"] } },
        },
        ["a"],
      ),
    );
    const r = lintPlan(g, { budgetUsd: 2 });
    expect(r.estimate).toEqual({ usd: 3, minutes: 15 });
    expect(r.warnings.map((w) => w.message)).toContain("estimated $3 is over the mission budget of $2");
  });
});

describe("planner output", () => {
  it("extracts JSON from a fence or bare braces, and reports schema errors for a retry", () => {
    expect(extractJson('here:\n```json\n{"a":1}\n```\nthanks')).toBe('{"a":1}');
    expect(extractJson('sure {"a": {"b": 2}} done')).toBe('{"a": {"b": 2}}');
    expect(parsePlan("no json here")).toEqual({ ok: false, errors: ["the answer contains no JSON object"] });
    const bad = parsePlan('```json\n{"tasks": [], "assumptions": [], "questions": []}\n```');
    expect(bad.ok).toBe(false);
    const good = parsePlan(`\`\`\`json\n${JSON.stringify(plan(task("a")))}\n\`\`\``);
    expect(good.ok && good.graph.tasks[0]?.key).toBe("a");
  });

  it("instructs contract-first planning with runnable checks and the repo map", () => {
    const text = plannerInstructions({
      goal: "Add OAuth",
      repoFiles: ["app/page.tsx"],
      availableTaskTypes: ["code.feature"],
      feedback: ["tasks.0.key: bad"],
    });
    expect(text).toContain("Add OAuth");
    expect(text).toContain("app/page.tsx");
    expect(text).toContain("design.api_contract");
    expect(text).toContain("tasks.0.key: bad");
    expect(text).toContain("```json");
  });
});

describe("plan edits", () => {
  const g = plan(task("a"), task("b", {}, ["a"]), task("c", {}, ["b"]));

  it("removes a task and keeps the order around it", () => {
    expect(applyPlanEdit(g, { op: "remove", key: "b" }).tasks.find((t) => t.key === "c")?.dependsOn).toEqual([
      "a",
    ]);
  });

  it("splits and merges", () => {
    const split = applyPlanEdit(g, { op: "split", key: "b", into: [task("b1"), task("b2", {}, ["b1"])] });
    expect(split.tasks.map((t) => t.key)).toEqual(["a", "b1", "b2", "c"]);
    expect(split.tasks.find((t) => t.key === "b1")?.dependsOn).toEqual(["a"]);
    expect(split.tasks.find((t) => t.key === "c")?.dependsOn.sort()).toEqual(["b1", "b2"]);
    const merged = applyPlanEdit(split, { op: "merge", keys: ["b1", "b2"], into: task("b") });
    expect(merged.tasks.find((t) => t.key === "b")?.dependsOn).toEqual(["a"]);
    expect(merged.tasks.find((t) => t.key === "c")?.dependsOn).toEqual(["b"]);
  });

  it("edits dependencies, budgets and approval gates, and refuses nonsense", () => {
    expect(applyPlanEdit(g, { op: "depend", key: "c", on: "a" }).tasks[2]?.dependsOn).toEqual(["b", "a"]);
    expect(applyPlanEdit(g, { op: "undepend", key: "c", on: "b" }).tasks[2]?.dependsOn).toEqual([]);
    expect(applyPlanEdit(g, { op: "budget", key: "a", usd: 2 }).tasks[0]?.contract.budget).toEqual({
      usd: 2,
    });
    expect(
      applyPlanEdit(g, { op: "gate", key: "a", on: true }).tasks[0]?.contract.acceptance.map((x) => x.kind),
    ).toEqual(["tests", "human"]);
    expect(() => applyPlanEdit(g, { op: "remove", key: "nope" })).toThrow(PlanEditError);
    expect(() => applyPlanEdit(plan(task("a")), { op: "remove", key: "a" })).toThrow(/at least one/);
    expect(() => applyPlanEdit(g, { op: "add", task: task("a") })).toThrow(/already exists/);
  });

  it("reorders without breaking dependencies", () => {
    const free = plan(task("a"), task("b"), task("c", {}, ["a"]));
    expect(applyPlanEdit(free, { op: "move", key: "b", before: "a" }).tasks.map((t) => t.key)).toEqual([
      "b",
      "a",
      "c",
    ]);
    expect(applyPlanEdit(free, { op: "move", key: "a", before: null }).tasks.map((t) => t.key)).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(() => applyPlanEdit(free, { op: "move", key: "c", before: "a" })).toThrow(/depends on a/);
  });

  it("chooses a task's mode on purpose, with its parameters", () => {
    const steps = ["0192f000-0000-7000-8000-000000000001", "0192f000-0000-7000-8000-000000000002"];
    const piped = applyPlanEdit(g, { op: "mode", key: "a", mode: "pipeline", steps }).tasks[0];
    expect(piped?.suggestedMode).toBe("pipeline");
    expect(piped?.modeParams).toEqual({ explicit: true, steps: steps.map((agentId) => ({ agentId })) });
    expect(applyPlanEdit(g, { op: "mode", key: "a", mode: "single" }).tasks[0]?.modeParams).toEqual({
      explicit: true,
    });
    expect(() => applyPlanEdit(g, { op: "mode", key: "a", mode: "pipeline" })).toThrow(/steps/);
  });
});

describe("static router adapts to the agents you have", () => {
  const agent = (id: string, over: Partial<RouteAgent> = {}): RouteAgent => ({
    id,
    name: id,
    model: "m",
    route: "api",
    vendor: "openai",
    taskTypes: ["code.feature", "write.doc", "plan.decompose"],
    local: false,
    runnable: true,
    ...over,
  });
  const t = {
    key: "x",
    type: "code.feature",
    sensitivity: "internal" as const,
    pinnedAgentId: null,
    mode: "single",
  };

  it("with no agents, the task waits with a reason", () => {
    expect(staticRoute(t, [])).toEqual({
      ok: false,
      reason: "no agents yet: add a connector and build an agent",
    });
  });

  it("with one agent, everything goes to it", () => {
    const r = staticRoute(t, [agent("solo")]);
    expect(r).toMatchObject({
      ok: true,
      agentId: "solo",
      rationale: "solo: the only agent that can do code.feature",
    });
  });

  it("with several, code goes to a coding CLI and writing to a model API", () => {
    const team = [
      agent("gpt"),
      agent("claude-code", { route: "cli", vendor: "anthropic", taskTypes: ["code.feature"] }),
    ];
    expect(staticRoute(t, team)).toMatchObject({ ok: true, agentId: "claude-code" });
    expect(staticRoute({ ...t, type: "write.doc" }, team)).toMatchObject({ ok: true, agentId: "gpt" });
  });

  it("degrades multi-agent modes to single and says so", () => {
    const r = staticRoute({ ...t, mode: "best_of_n" }, [agent("solo")]);
    expect(r).toMatchObject({
      ok: true,
      mode: "single",
      degraded: expect.stringContaining("needs 2+ agents"),
    });
  });

  it("honours pins, never sends confidential work off the machine, and skips agents that cannot run", () => {
    expect(staticRoute({ ...t, pinnedAgentId: "b" }, [agent("a"), agent("b")])).toMatchObject({
      agentId: "b",
      rationale: "b (pinned)",
    });
    expect(staticRoute({ ...t, sensitivity: "confidential" }, [agent("cloud")])).toEqual({
      ok: false,
      reason: "confidential: needs a local model agent",
    });
    expect(
      staticRoute({ ...t, sensitivity: "confidential" }, [agent("cloud"), agent("ollama", { local: true })]),
    ).toMatchObject({ agentId: "ollama" });
    expect(staticRoute(t, [agent("broke", { runnable: false })])).toMatchObject({ ok: false });
    expect(staticRoute({ ...t, type: "media.video" }, [agent("a")])).toEqual({
      ok: false,
      reason: "none of your 1 agent(s) can do media.video",
    });
  });

  it("plans with a model API agent", () => {
    expect(choosePlanner([agent("cli", { route: "cli" }), agent("api")], null)).toMatchObject({
      ok: true,
      agentId: "api",
    });
    expect(choosePlanner([agent("cli", { route: "cli" })], null)).toMatchObject({ ok: false });
  });
});

describe("scheduler", () => {
  const st = (
    id: string,
    status: SchedTask["status"],
    deps: string[] = [],
    footprint = [`src/${id}/**`],
    over: Partial<SchedTask> = {},
  ): SchedTask => ({
    id,
    key: id,
    status,
    dependsOn: deps,
    footprint,
    isCode: true,
    blockedReason: null,
    ...over,
  });
  const snap = (tasks: SchedTask[], over = {}) => ({
    missionStatus: "running",
    tasks,
    heldLeases: [],
    maxParallel: 4,
    ...over,
  });

  it("does nothing unless the mission is running", () => {
    expect(decide(snap([st("a", "pending")], { missionStatus: "awaiting_approval" }))).toEqual([]);
  });

  it("readies and dispatches tasks whose dependencies are done, in parallel when their files differ", () => {
    const actions = decide(
      snap([
        st("a", "done"),
        st("b", "pending", ["a"]),
        st("c", "pending", ["a"]),
        st("d", "pending", ["b"]),
      ]),
    );
    expect(actions).toEqual([
      { kind: "ready", taskId: "b" },
      { kind: "ready", taskId: "c" },
      { kind: "dispatch", taskId: "b" },
      { kind: "dispatch", taskId: "c" },
    ]);
  });

  it("never leases the same files twice: an overlapping task is blocked, then unblocked when free", () => {
    const blocked = decide(
      snap([st("a", "running", [], ["src/x/**"]), st("b", "ready", [], ["src/x/y.ts"])]),
    );
    expect(blocked).toEqual([
      {
        kind: "block",
        taskId: "b",
        reason: `${LEASE_BLOCK} waits for a to release files it may also change`,
      },
    ]);
    const freed = decide(
      snap([
        st("a", "done", [], ["src/x/**"]),
        st("b", "blocked", [], ["src/x/y.ts"], { blockedReason: `${LEASE_BLOCK} waits for a` }),
      ]),
    );
    expect(freed).toEqual([
      { kind: "unblock", taskId: "b" },
      { kind: "dispatch", taskId: "b" },
    ]);
    const otherMission = decide(
      snap([st("b", "ready", [], ["src/x/y.ts"])], { heldLeases: [{ taskId: "zz", resource: "src/x/**" }] }),
    );
    expect(otherMission[0]?.kind).toBe("block");
  });

  it("does not run two code tasks without footprints at once, but non-code tasks freely", () => {
    const a = decide(snap([st("a", "ready", [], []), st("b", "ready", [], [])]));
    expect(a.filter((x) => x.kind === "dispatch")).toHaveLength(1);
    const docs = decide(
      snap([st("a", "ready", [], [], { isCode: false }), st("b", "ready", [], [], { isCode: false })]),
    );
    expect(docs.filter((x) => x.kind === "dispatch")).toHaveLength(2);
  });

  it("respects the parallelism cap, finishes, and fails on a failed task", () => {
    expect(
      decide(snap([st("a", "ready"), st("b", "ready"), st("c", "running")], { maxParallel: 2 })).filter(
        (x) => x.kind === "dispatch",
      ),
    ).toHaveLength(1);
    expect(decide(snap([st("a", "done"), st("b", "cancelled")]))).toEqual([{ kind: "mission_done" }]);
    expect(decide(snap([st("a", "failed"), st("b", "pending", ["a"])]))).toEqual([
      { kind: "mission_failed", reason: "task a failed" },
    ]);
  });

  it("is idempotent: the same snapshot gives the same actions", () => {
    const s = snap([st("a", "done"), st("b", "pending", ["a"])]);
    expect(decide(s)).toEqual(decide(s));
  });
});

describe("handoff packets", () => {
  it("carries the sender's sections and marks the body untrusted", () => {
    const output =
      "Added the auth routes.\n\n## Decisions\n- Sessions are cookies\n- Tokens expire in 1h\n\n## Risks\n- No rate limit yet\n\n## Next steps\n1. Add the sign-in page\n";
    expect(section(output, /^decisions?\b/i)).toEqual(["Sessions are cookies", "Tokens expire in 1h"]);
    const p = buildHandoff({
      id: "0192b3c4-5d6e-7f80-9a1b-2c3d4e5f6a7b",
      createdAt: "2026-10-23T10:00:00.000Z",
      mission: { id: "m", title: "OAuth", goal: "Add OAuth" },
      from: {
        taskKey: "api.auth",
        agentKey: "codex/gpt",
        vendor: "openai",
        summary: "Added the auth routes.",
        output,
      },
      to: { taskKey: "web.signin", objective: "Build the sign-in page" },
      artifacts: [{ kind: "diff", ref: "artifact:1", sha256: "a".repeat(64) }],
      contracts: [{ name: "contract.auth-api", version: "1", ref: "contract:1" }],
      checks: [{ kind: "tests", passed: true, summary: "12 passed", ref: "check:1" }],
      constraints: ["Do not touch billing"],
      inheritedDecisions: [{ statement: "Use OAuth with PKCE" }, { statement: "Sessions are cookies" }],
    });
    expect(p).toMatchObject({
      trust: "untrusted-content",
      done: ["Added the auth routes."],
      decisions: [
        { id: "D1", statement: "Use OAuth with PKCE" },
        { id: "D2", statement: "Sessions are cookies" },
        { id: "D3", statement: "Tokens expire in 1h" },
      ],
      risks: ["No rate limit yet"],
      nextSteps: ["Add the sign-in page"],
      evidence: [{ kind: "test", summary: "tests passed: 12 passed" }],
    });
  });
});

describe("diff scope", () => {
  it("passes changes inside the footprint and names the ones outside", async () => {
    const { diffScope } = await import("../src/index");
    expect(diffScope(["api/a.ts", "api/b/c.ts"], ["api/**"])).toMatchObject({ passed: true });
    expect(diffScope(["api/a.ts", "web/x.html"], ["api/**"])).toMatchObject({
      passed: false,
      outside: ["web/x.html"],
    });
    expect(diffScope([], ["api/**"]).passed).toBe(true);
    expect(diffScope(["anything"], undefined).passed).toBe(true);
  });

  it("lets a task in revise go again without blocking on its own files", async () => {
    const { decide } = await import("../src/index");
    const t = {
      id: "a",
      key: "a",
      status: "revise" as const,
      dependsOn: [],
      footprint: ["src/a/**"],
      isCode: true,
      blockedReason: null,
    };
    expect(
      decide({
        missionStatus: "running",
        tasks: [t],
        heldLeases: [{ taskId: "a", resource: "src/a/**" }],
        maxParallel: 2,
      }),
    ).toEqual([{ kind: "dispatch", taskId: "a" }]);
  });
});
