// M4 acceptance: every execution mode runs end to end through the orchestrator with scripted vendors. Each mission is
// one task; the router picks the mode by the default rules (or the plan sets it), and the scoreboard learns from the
// outcome: pass/revise/fail per attempt, Elo from the judge. Needs Postgres and Docker (code tasks run in sandboxes).
import { readEventsSince, schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { dockerAvailable } from "@brio/runner";
import { and, asc, eq, gt } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";
import { type CallInfo, type Reply, ScriptedVendors, taskTitle } from "./vendors";

const hasDocker = await dockerAvailable();
const OPENAI_KEY = ["sk", "proj", "modes0123456789abcdefgh"].join("-");
const ANTHROPIC_KEY = ["sk", "ant", "api03", "modes0123456789abcdefgh"].join("-");

type Acceptance = { kind: string; hard: boolean; command?: string };
const plannedTask = (o: {
  key: string;
  type: string;
  title: string;
  acceptance: Acceptance[];
  footprint?: string[];
  mode?: string;
}) => ({
  tasks: [
    {
      key: o.key,
      type: o.type,
      title: o.title,
      contract: {
        objective: o.title,
        inputs: [],
        outputs: [{ kind: o.footprint ? "diff" : "report", description: o.title }],
        acceptance: o.acceptance,
        constraints: [],
        ...(o.footprint ? { expectedFootprint: { paths: o.footprint } } : {}),
        sensitivity: "internal",
      },
      dependsOn: [],
      suggestedMode: o.mode ?? "single",
      estimate: { usd: 0.01, minutes: 1 },
    },
  ],
  assumptions: [],
  questions: [],
});

const tests = (dir: string): Acceptance => ({
  kind: "tests",
  command: `node --test '${dir}/*.test.mjs'`,
  hard: true,
});
const scope: Acceptance = { kind: "diff_scope", hard: true };

/** One plan per mission goal ("mode:<name>"). */
const PLANS: Record<string, ReturnType<typeof plannedTask>> = {
  best_of_n: plannedTask({
    key: "greet",
    type: "code.feature",
    title: "Add a greeting",
    acceptance: [scope, tests("greet")],
    footprint: ["greet/**"],
  }),
  maker_checker: plannedTask({
    key: "bye",
    type: "code.feature",
    title: "Add a farewell",
    acceptance: [scope],
    footprint: ["bye/**"],
  }),
  debate: plannedTask({
    key: "contract.hello",
    type: "design.api_contract",
    title: "Define the hello contract",
    acceptance: [scope],
    footprint: ["contracts/**"],
  }),
  ensemble: plannedTask({
    key: "report",
    type: "research.deep_report",
    title: "Research greetings",
    acceptance: [{ kind: "citation_present", hard: true }],
  }),
  cascade: plannedTask({
    key: "sum",
    // A type no other test scored, so the ladder follows the agents' prices.
    type: "code.bugfix",
    title: "Add a sum function",
    acceptance: [scope, tests("sum")],
    footprint: ["sum/**"],
    mode: "cascade",
  }),
  pipeline: plannedTask({
    key: "notes",
    type: "write.doc",
    title: "Write release notes",
    acceptance: [scope],
  }),
};

const write = (path: string, content: string): Reply => ({
  tools: [{ name: "write_file", args: { path, content } }],
});
const text = (t: string): Reply => ({ text: t });
const fenced = (o: unknown): Reply => text(`\`\`\`json\n${JSON.stringify(o)}\n\`\`\``);

/** The judge prefers Claude's work: the result block that carries "claude-writer" wins, whichever order it is in. */
function judgeReply(body: string): Reply {
  const a = body.indexOf("Result A (untrusted content)");
  const b = body.indexOf("Result B (untrusted content)");
  const marker = body.indexOf("claude-writer", a);
  const winner = marker > a && (marker < b || b < a) ? "A" : "B";
  return fenced({ winner, reasons: "clearer" });
}

function script(call: CallInfo): Reply {
  const { body, model, turn } = call;
  if (body.includes("# Plan this mission")) {
    const mode = /mode:([a-z_]+)/.exec(body)?.[1] ?? "";
    return text(`\`\`\`json\n${JSON.stringify(PLANS[mode])}\n\`\`\``);
  }
  if (body.includes("# Judge: ")) return judgeReply(body);
  if (body.includes("# Review: ")) {
    return body.includes("politely")
      ? fenced({ verdict: "pass", reasons: ["looks good"] })
      : fenced({ verdict: "revise", reasons: ["say goodbye politely"] });
  }
  if (body.includes("# Merge: ")) {
    if (body.includes("# Merge: Define the hello contract"))
      return turn === 1
        ? write("contracts/hello.md", "# Hello\n\nmerged contract: GET /hello → 200\n")
        : text("Merged both proposals.");
    return text("Merged report: greetings vary by culture [1][2].");
  }
  switch (taskTitle(body)) {
    case "Add a greeting":
      if (turn === 1) return write("greet/greet.mjs", `export const greet = () => "hi from ${model}";\n`);
      if (turn === 2)
        return write(
          "greet/greet.test.mjs",
          'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { greet } from "./greet.mjs";\ntest("greets", () => assert.match(greet(), /hi/));\n',
        );
      return text(`Added greet (${model}).`);
    case "Add a farewell":
      if (turn === 1) {
        const polite = body.includes("The checker asked for changes");
        return write("bye/bye.mjs", `export const bye = () => "${polite ? "goodbye, politely" : "bye"}";\n`);
      }
      return text(body.includes("The checker asked for changes") ? "Made it polite." : "Added bye.");
    case "Define the hello contract":
      return turn === 1
        ? write("contracts/hello.md", `# Hello\n\nproposal by ${model}: GET /hello\n`)
        : text(`Proposal from ${model}.`);
    case "Research greetings":
      return text(`Finding from ${model}: people say hello [1].`);
    case "Add a sum function": {
      // The cheapest agent gets it wrong; the escalation gets it right.
      const right = model !== "planner";
      if (turn === 1) return write("sum/sum.mjs", `export const sum = (a, b) => a ${right ? "+" : "-"} b;\n`);
      if (turn === 2)
        return write(
          "sum/sum.test.mjs",
          'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sum } from "./sum.mjs";\ntest("adds", () => assert.equal(sum(2, 3), 5));\n',
        );
      return text(`Added sum (${model}).`);
    }
    case "Write release notes":
      return body.includes("The previous step's result")
        ? text(`Polished by ${model}: ${/DRAFT-[a-z-]+/.exec(body)?.[0] ?? "no draft"}`)
        : text(`DRAFT-${model}`);
    default:
      return text(`unexpected request: ${body.slice(0, 120)}`);
  }
}

describe.skipIf(!hasTestDatabase || !hasDocker)("M4 acceptance: execution modes end to end", () => {
  const vendors = new ScriptedVendors(script);
  let h: Harness;
  let c: Client;
  const agents: Record<string, string> = {};

  beforeAll(async () => {
    h = await startHarness({ fetch: vendors.fetch });
    c = new Client(h);
    await c.signIn("modes@example.com");
    await c.request("POST", "/v1/workspaces", { name: "Modes" });
    const openai = (
      await c.request("POST", "/v1/connectors", { registryKey: "openai-api", apiKey: OPENAI_KEY })
    ).json().connector;
    const anthropic = (
      await c.request("POST", "/v1/connectors", { registryKey: "claude-api", apiKey: ANTHROPIC_KEY })
    ).json().connector;
    // Different prices, so a cascade's ladder (cheapest first) is known.
    const price = (inputPerM: number) => ({
      inputPerM,
      outputPerM: inputPerM * 2,
      cachedInputPerM: null,
      cacheWritePerM: null,
    });
    for (const [name, connectorId, model, usd] of [
      ["planner", openai.id, "planner", 0.5],
      ["coder", openai.id, "gpt-coder", 1],
      ["writer", anthropic.id, "claude-writer", 3],
    ] as const) {
      const r = await c.request("POST", "/v1/agents", {
        connectorId,
        name,
        model,
        priceOverride: price(usd),
        limits: { maxCostUsd: 1 },
      });
      expect(r.statusCode, r.body).toBe(201);
      agents[name] = r.json().agent.id;
    }
  });
  afterAll(async () => h?.close());

  const diagnose = async (missionId: string) => {
    const ts = await h.db.db.select().from(schema.tasks).where(eq(schema.tasks.missionId, missionId));
    const lines: string[] = [];
    for (const t of ts) {
      lines.push(`${t.key}: ${t.status} ${t.blockedReason ?? ""} ${JSON.stringify(t.modeParams)}`);
      for (const a of await h.db.db.select().from(schema.attempts).where(eq(schema.attempts.taskId, t.id)))
        lines.push(`  ${a.role} ${a.status}: ${a.exitReason ?? ""} checks=${JSON.stringify(a.checks)}`);
    }
    return lines.join("\n");
  };

  const waitFor = async (
    missionId: string,
    ok: (m: typeof schema.missions.$inferSelect) => boolean,
    ms = 150_000,
  ) => {
    const until = Date.now() + ms;
    for (;;) {
      const [m] = await h.db.db.select().from(schema.missions).where(eq(schema.missions.id, missionId));
      if (m && ok(m)) return m;
      if (m?.status === "failed")
        throw new Error(`mission failed: ${m.blockedReason}\n${await diagnose(missionId)}`);
      if (Date.now() > until) throw new Error(`mission is ${m?.status}\n${await diagnose(missionId)}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  /** Plans "mode:<name>", applies plan edits, approves, and returns the mission and its one task. */
  async function start(mode: string, edits: (taskKey: string) => unknown[] = () => []) {
    const res = await c.request("POST", "/v1/missions", {
      goal: `Exercise mode:${mode}`,
      plannerAgentId: agents.planner,
    });
    expect(res.statusCode, res.body).toBe(201);
    const missionId = res.json().mission.id as string;
    await waitFor(missionId, (m) => m.status === "awaiting_approval", 60_000);
    let [plan] = (await c.request("GET", `/v1/missions/${missionId}/plans`)).json().plans.slice(-1);
    const key = PLANS[mode]?.tasks[0]?.key as string;
    const list = edits(key);
    if (list.length) {
      const e = await c.request("POST", `/v1/missions/${missionId}/plans/${plan.version}/edits`, {
        edits: list,
      });
      expect(e.statusCode, e.body).toBe(201);
      plan = e.json().plan;
    }
    const ok = await c.request("POST", `/v1/missions/${missionId}/plans/${plan.version}/approve`);
    expect(ok.statusCode, ok.body).toBe(200);
    return missionId;
  }

  async function evidence(missionId: string) {
    // The mission's one planned task (the planning task is plan version 0).
    const [task] = await h.db.db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.missionId, missionId), gt(schema.tasks.planVersion, 0)));
    const tried = await h.db.db
      .select()
      .from(schema.attempts)
      .where(and(eq(schema.attempts.taskId, task!.id)))
      .orderBy(asc(schema.attempts.createdAt));
    const events = await readEventsSince(h.db.db, missionId, 0, 10_000);
    const route = events.find((e) => e.type === "task.routed")?.payload as {
      mode: string;
      agents: { agentId: string; role: string; name: string }[];
      rationale: string;
    };
    const purpose = (a: (typeof tried)[number]) =>
      (a.dispatch as { mode?: { purpose: string } } | null)?.mode?.purpose ?? "single";
    const params = task!.modeParams as { result?: { attemptId: string; note: string } };
    const accepted = tried.find((a) => a.id === params.result?.attemptId);
    return { task: task!, tried, events, route, purpose, accepted, params };
  }

  const score = async (agentKey: string, taskType: string) =>
    (
      await h.db.db
        .select()
        .from(schema.scores)
        .where(and(eq(schema.scores.agentKey, agentKey), eq(schema.scores.taskType, taskType)))
    )[0];

  it("best of n: two vendors build it, tests pass for both, the judge picks in both orders and Elo moves", async () => {
    const id = await start("best_of_n");
    await waitFor(id, (m) => m.status === "done");
    const e = await evidence(id);
    expect(e.route.mode).toBe("best_of_n");
    expect(e.route.rationale).toMatch(/^best of 2: /);
    const makes = e.tried.filter((a) => e.purpose(a) === "make");
    const judges = e.tried.filter((a) => e.purpose(a) === "judge");
    expect(makes).toHaveLength(2);
    expect(
      new Set(
        makes.map(
          (a) => (a.dispatch as { agent: { connector: { presetKey: string } } }).agent.connector.presetKey,
        ),
      ).size,
    ).toBe(2);
    expect(judges).toHaveLength(2);
    expect(e.events.filter((x) => x.type === "judge.verdict")).toHaveLength(2);
    // The judge's agent is not one of the candidates.
    expect(makes.map((a) => a.agentId)).not.toContain(judges[0]?.agentId);
    expect(e.accepted?.agentId).toBe(agents.writer);
    expect(e.params.result?.note).toMatch(/chosen by the judge/);
    for (const a of makes) {
      const [row] = await h.db.db.select().from(schema.attempts).where(eq(schema.attempts.id, a.id));
      expect(row?.scored).toBe("pass");
    }
    const winner = await score("anthropic/claude-writer", "code.feature");
    const loserKey = makes.find((a) => a.agentId !== agents.writer)?.dispatch as { agent: { model: string } };
    const loser = await score(`openai/${loserKey.agent.model}`, "code.feature");
    expect(winner!.elo).toBeGreaterThan(loser!.elo);
    expect(winner!.n).toBe(1);
    const done = e.events.find((x) => x.type === "task.done")?.payload as { mode: string };
    expect(done.mode).toBe("best_of_n");
  }, 200_000);

  it("maker–checker: a reviewer from another vendor sends it back once, then approves the revision", async () => {
    const id = await start("maker_checker");
    await waitFor(id, (m) => m.status === "done");
    const e = await evidence(id);
    expect(e.route.mode).toBe("maker_checker");
    expect(e.tried.map((a) => e.purpose(a))).toEqual(["make", "review", "revise", "review"]);
    const [make, review, revise] = e.tried;
    const vendor = (a: typeof make) =>
      (a!.dispatch as { agent: { connector: { presetKey: string } } }).agent.connector.presetKey;
    expect(vendor(review)).not.toBe(vendor(make));
    expect(revise?.agentId).toBe(make?.agentId);
    expect(e.accepted?.id).toBe(revise?.id);
    const verdicts = e.events
      .filter((x) => x.type === "review.verdict")
      .map((x) => (x.payload as { verdict: string }).verdict);
    expect(verdicts).toEqual(["revise", "pass"]);
    const reviews = await h.db.db.select().from(schema.reviews).where(eq(schema.reviews.taskId, e.task.id));
    expect(reviews.map((r) => [r.kind, r.verdict])).toEqual([
      ["review", "revise"],
      ["review", "pass"],
    ]);
    const scored = await h.db.db.select().from(schema.attempts).where(eq(schema.attempts.taskId, e.task.id));
    expect(scored.find((a) => a.id === make?.id)?.scored).toBe("revise");
    expect(scored.find((a) => a.id === revise?.id)?.scored).toBe("pass");
  }, 200_000);

  it("debate: two proposals, an outside judge, then a merge that becomes the contract", async () => {
    const id = await start("debate");
    await waitFor(id, (m) => m.status === "done");
    const e = await evidence(id);
    expect(e.route.mode).toBe("debate");
    const roles = e.route.agents.map((a) => a.role).sort();
    expect(roles).toEqual(["candidate", "candidate", "judge", "merger"]);
    expect(e.tried.map((a) => e.purpose(a)).sort()).toEqual(["judge", "judge", "make", "make", "merge"]);
    expect(e.accepted && e.purpose(e.accepted)).toBe("merge");
    const [contract] = await h.db.db
      .select()
      .from(schema.contracts)
      .where(eq(schema.contracts.missionId, id));
    expect(String(contract?.spec)).toContain("merged contract");
  }, 200_000);

  it("ensemble: researchers from different vendors, a merger, then a person accepts the merged report", async () => {
    const id = await start("ensemble");
    const until = Date.now() + 120_000;
    let e = await evidence(id);
    while (e.task.status !== "verifying") {
      if (Date.now() > until) throw new Error(await diagnose(id));
      await new Promise((r) => setTimeout(r, 250));
      e = await evidence(id);
    }
    expect(e.route.mode).toBe("ensemble");
    expect(e.accepted && e.purpose(e.accepted)).toBe("merge");
    // The citation check waits for a person (until the M5 verifier); asked once, for the chosen result only.
    expect(e.events.filter((x) => x.type === "approval.requested")).toHaveLength(1);
    const r = await c.request("POST", `/v1/tasks/${e.task.id}/review`, { verdict: "pass", reasons: "good" });
    expect(r.statusCode, r.body).toBe(200);
    await waitFor(id, (m) => m.status === "done");
    const merged = await h.db.db
      .select()
      .from(schema.artifacts)
      .where(and(eq(schema.artifacts.attemptId, e.accepted!.id), eq(schema.artifacts.kind, "report")));
    expect(merged).toHaveLength(1);
  }, 200_000);

  it("cascade: the cheapest agent fails its tests, the next one up passes", async () => {
    const id = await start("cascade");
    await waitFor(id, (m) => m.status === "done");
    const e = await evidence(id);
    expect(e.route.mode).toBe("cascade");
    expect(e.route.agents.map((a) => a.name)).toEqual(["planner", "coder", "writer"]);
    const makes = e.tried.filter((a) => e.purpose(a) === "make");
    expect(makes.map((a) => a.agentId)).toEqual([agents.planner, agents.coder]);
    expect(e.accepted?.agentId).toBe(agents.coder);
    const scored = await h.db.db.select().from(schema.attempts).where(eq(schema.attempts.taskId, e.task.id));
    expect(scored.find((a) => a.agentId === agents.planner)?.scored).toBe("fail");
    expect(scored.find((a) => a.agentId === agents.coder)?.scored).toBe("pass");
  }, 200_000);

  it("pipeline: the plan names the agents in order; each step builds on the one before", async () => {
    const id = await start("pipeline", (key) => [
      { op: "mode", key, mode: "pipeline", steps: [agents.writer, agents.coder] },
    ]);
    await waitFor(id, (m) => m.status === "done");
    const e = await evidence(id);
    expect(e.route.mode).toBe("pipeline");
    expect(e.tried.map((a) => a.agentId)).toEqual([agents.writer, agents.coder]);
    expect(e.accepted?.agentId).toBe(agents.coder);
    const final = e.events.find((x) => x.type === "attempt.message" && x.attemptId === e.accepted?.id);
    expect((final?.payload as { text?: string } | undefined)?.text).toContain("DRAFT-claude-writer");
  }, 200_000);

  it("left a scoreboard with history", async () => {
    const history = await h.db.db.select().from(schema.scoreHistory);
    expect(history.length).toBeGreaterThan(5);
    const res = await c.request("GET", "/v1/scoreboard?taskType=code.feature");
    expect(res.statusCode, res.body).toBe(200);
    const board = res.json() as {
      taskTypes: string[];
      vendors: string[];
      rows: {
        agentKey: string;
        agents: string[];
        taskType: string;
        elo: number;
        n: number;
        trend: unknown[];
      }[];
    };
    expect(board.taskTypes).toEqual(expect.arrayContaining(["code.bugfix", "code.feature"]));
    expect(board.vendors).toEqual(["anthropic", "openai"]);
    expect(board.rows.every((r) => r.taskType === "code.feature")).toBe(true);
    const claude = board.rows.find((r) => r.agentKey === "anthropic/claude-writer");
    expect(claude?.agents).toEqual(["writer"]);
    expect(claude?.trend.length).toBeGreaterThan(0);
    const anthropicOnly = (await c.request("GET", "/v1/scoreboard?vendor=anthropic")).json();
    expect(anthropicOnly.rows.every((r: { agentKey: string }) => r.agentKey.startsWith("anthropic/"))).toBe(
      true,
    );
  });

  it("takes a thumbs up once per person and feeds it to the agent's score", async () => {
    const [made] = await h.db.db
      .select({ id: schema.attempts.id })
      .from(schema.attempts)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.attempts.taskId))
      .where(
        and(
          eq(schema.attempts.agentId, agents.writer!),
          eq(schema.tasks.type, "code.feature"),
          eq(schema.attempts.scored, "pass"),
        ),
      );
    const before = await score("anthropic/claude-writer", "code.feature");
    const up = await c.request("POST", `/v1/attempts/${made!.id}/rating`, { rating: 1, comment: "nice" });
    expect(up.statusCode, up.body).toBe(201);
    const after = await score("anthropic/claude-writer", "code.feature");
    expect(after!.alpha).toBeCloseTo(before!.alpha + 0.5, 5);
    expect((await c.request("POST", `/v1/attempts/${made!.id}/rating`, { rating: -1 })).statusCode).toBe(409);
  });
});
