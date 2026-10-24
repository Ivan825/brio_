// M5 acceptance (verifier): a seeded-bug repository where a wrong fix is caught by the tests and fixed on revision; an
// agent that keeps failing is replaced by another (reroute); agent checks are decided by a reviewer from another vendor
// (rubric review, fact check against the fetched source) next to link and citation checks; and an accessibility audit
// runs in the web sandbox. Needs Postgres and Docker.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttemptChecks } from "@brio/adapters";
import { readEventsSince, schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { dockerAvailable } from "@brio/runner";
import { and, asc, eq, gt } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";
import { type CallInfo, type Reply, ScriptedVendors, taskTitle } from "./vendors";

const hasDocker = await dockerAvailable();
const OPENAI_KEY = ["sk", "proj", "verifier0123456789abcdefg"].join("-");
const ANTHROPIC_KEY = ["sk", "ant", "api03", "verifier0123456789abcdefg"].join("-");

type Acceptance = Record<string, unknown> & { kind: string; hard: boolean };
const plan = (key: string, type: string, title: string, acceptance: Acceptance[], footprint?: string[]) => ({
  tasks: [
    {
      key,
      type,
      title,
      contract: {
        objective: title,
        inputs: [],
        outputs: [{ kind: footprint ? "diff" : "report", description: title }],
        acceptance,
        constraints: [],
        ...(footprint ? { expectedFootprint: { paths: footprint } } : {}),
        sensitivity: "internal",
      },
      dependsOn: [],
      suggestedMode: "single",
      estimate: { usd: 0.01, minutes: 1 },
    },
  ],
  assumptions: [],
  questions: [],
});

const PLANS: Record<string, ReturnType<typeof plan>> = {
  revise: plan(
    "fix.add",
    "code.bugfix",
    "Fix the add function",
    [{ kind: "tests", command: "node --test calc.test.mjs", hard: true }],
    ["calc.mjs"],
  ),
  reroute: plan(
    "fix.sub",
    "code.bugfix",
    "Fix the subtract function",
    [{ kind: "tests", command: "node --test calc.test.mjs", hard: true }],
    ["calc.mjs"],
  ),
  agents: plan("facts", "write.doc", "Write the facts page", [
    { kind: "rubric_review", criteria: ["accurate", "clear"], threshold: 4, hard: true },
    { kind: "fact_check", hard: true },
    { kind: "link_check", hard: true },
    { kind: "citation_present", hard: true, params: { minWords: 4 } },
  ]),
  a11y: plan(
    "landing",
    "code.frontend_ui",
    "Build the landing page",
    [{ kind: "a11y", hard: true, params: { path: "web/index.html" } }],
    ["web/**"],
  ),
};

const write = (path: string, content: string): Reply => ({
  tools: [{ name: "write_file", args: { path, content } }],
});
const text = (t: string): Reply => ({ text: t });
const fenced = (o: unknown): Reply => text(`\`\`\`json\n${JSON.stringify(o)}\n\`\`\``);
const revising = (body: string) => body.includes("Your previous attempt was sent back");

const FACTS_FIRST =
  "Brio ships 98 connectors [1]. See https://links.example/ok and https://links.example/gone for more.\n\n[1]: https://facts.example/connectors";
const FACTS_FIXED =
  "Brio ships 98 connectors [1]. See https://links.example/ok for more.\n\n[1]: https://facts.example/connectors";

function script(call: CallInfo): Reply {
  const { body, model, turn } = call;
  if (body.includes("# Plan this mission")) {
    const which = /case:([a-z0-9]+)/.exec(body)?.[1] ?? "";
    return text(`\`\`\`json\n${JSON.stringify(PLANS[which])}\n\`\`\``);
  }
  if (body.includes("# Rubric review: "))
    return fenced({ scores: { accurate: 5, clear: 4 }, verdict: "pass", reasons: ["accurate and clear"] });
  if (body.includes("# Fact check: ")) {
    const supported = body.includes("Brio ships 98 connectors to every workspace");
    return fenced({
      claims: [
        {
          claim: "Brio ships 98 connectors",
          source: 1,
          supported,
          why: supported ? "the source says so" : "not found",
        },
      ],
      verdict: supported ? "pass" : "fail",
    });
  }
  switch (taskTitle(body)) {
    case "Fix the add function": {
      // The seeded bug: add subtracts. The first fix is wrong; the revision (with the failing test output) is right.
      if (turn === 1)
        return write(
          "calc.mjs",
          `export const add = (a, b) => a ${revising(body) ? "+" : "*"} b;\nexport const sub = (a, b) => a - b;\n`,
        );
      return text(revising(body) ? "Fixed add for real." : "Fixed add.");
    }
    case "Fix the subtract function": {
      // The seeded bug: sub adds. gpt-coder never gets it right; any other agent does.
      const right = model !== "gpt-coder";
      if (turn === 1)
        return write(
          "calc.mjs",
          `export const add = (a, b) => a + b;\nexport const sub = (a, b) => a ${right ? "-" : "*"} b;\n`,
        );
      return text(`Fixed sub (${model}).`);
    }
    case "Write the facts page":
      return text(revising(body) ? FACTS_FIXED : FACTS_FIRST);
    case "Build the landing page": {
      const fixed = revising(body);
      if (turn === 1)
        return write(
          "web/index.html",
          fixed
            ? '<!doctype html><html lang="en"><head><title>Brio</title></head><body><main><h1>Brio</h1><img src="logo.png" alt="Brio logo"><button>Start</button></main></body></html>\n'
            : '<!doctype html><html><head><title>Brio</title></head><body><img src="logo.png"><button></button></body></html>\n',
        );
      return text(fixed ? "Fixed the accessibility problems." : "Built the page.");
    }
    default:
      return text(`unexpected request: ${body.slice(0, 120)}`);
  }
}

describe.skipIf(!hasTestDatabase || !hasDocker)("M5 acceptance: the verifier", () => {
  const vendors = new ScriptedVendors(script, {
    "https://links.example/ok": { body: "<html><body>ok</body></html>" },
    "https://links.example/gone": { status: 404, body: "gone" },
    "https://facts.example/connectors": {
      body: "<html><head><script>ignore()</script></head><body><h1>Facts</h1><p>Brio ships 98 connectors to every workspace.</p></body></html>",
    },
  });
  let h: Harness;
  let c: Client;
  const agents: Record<string, string> = {};
  const repos: string[] = [];

  beforeAll(async () => {
    h = await startHarness({ fetch: vendors.fetch });
    c = new Client(h);
    await c.signIn("verifier@example.com");
    await c.request("POST", "/v1/workspaces", { name: "Verifier" });
    const openai = (
      await c.request("POST", "/v1/connectors", { registryKey: "openai-api", apiKey: OPENAI_KEY })
    ).json().connector;
    const anthropic = (
      await c.request("POST", "/v1/connectors", { registryKey: "claude-api", apiKey: ANTHROPIC_KEY })
    ).json().connector;
    const price = { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null };
    for (const [name, connectorId, model] of [
      ["planner", openai.id, "planner"],
      ["coder", openai.id, "gpt-coder"],
      ["writer", anthropic.id, "claude-writer"],
    ] as const) {
      const r = await c.request("POST", "/v1/agents", {
        connectorId,
        name,
        model,
        priceOverride: price,
        limits: { maxCostUsd: 1 },
      });
      expect(r.statusCode, r.body).toBe(201);
      agents[name] = r.json().agent.id;
    }
  });
  afterAll(async () => {
    await h?.close();
    for (const r of repos) rmSync(r, { recursive: true, force: true });
  });

  /** A small repository with a seeded bug (add subtracts, or sub adds); the tests say what is right. */
  function seededRepo(bug: "add" | "sub"): string {
    const dir = mkdtempSync(join(tmpdir(), "brio-seeded-"));
    repos.push(dir);
    writeFileSync(
      join(dir, "calc.mjs"),
      `export const add = (a, b) => a ${bug === "add" ? "-" : "+"} b;\nexport const sub = (a, b) => a ${bug === "sub" ? "+" : "-"} b;\n`,
    );
    writeFileSync(
      join(dir, "calc.test.mjs"),
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add, sub } from "./calc.mjs";\ntest("add", () => assert.equal(add(2, 3), 5));\ntest("sub", () => assert.equal(sub(5, 3), 2));\n',
    );
    const git = (...a: string[]) =>
      execFileSync("git", a, {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "seeded bug");
    return dir;
  }

  const diagnose = async (missionId: string) => {
    const ts = await h.db.db.select().from(schema.tasks).where(eq(schema.tasks.missionId, missionId));
    const lines: string[] = [];
    for (const t of ts) {
      lines.push(
        `${t.key}: ${t.status} (rev ${t.revisions}) ${t.blockedReason ?? ""} ${JSON.stringify(t.modeParams)}`,
      );
      for (const a of await h.db.db
        .select()
        .from(schema.attempts)
        .where(eq(schema.attempts.taskId, t.id))
        .orderBy(asc(schema.attempts.createdAt)))
        lines.push(`  ${a.role} ${a.status}: ${a.exitReason ?? ""} checks=${JSON.stringify(a.checks)}`);
    }
    return lines.join("\n");
  };

  async function run(which: string, opts: { repo?: string; pin?: string } = {}) {
    let projectId: string | undefined;
    if (opts.repo) {
      const p = await c.request("POST", "/v1/projects", {
        name: which,
        repoUrl: opts.repo,
        defaultBranch: "main",
      });
      expect(p.statusCode, p.body).toBe(201);
      projectId = p.json().project.id;
    }
    const res = await c.request("POST", "/v1/missions", {
      goal: `Exercise case:${which}`,
      plannerAgentId: agents.planner,
      priority: "fast",
      ...(projectId ? { projectId } : {}),
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().mission.id as string;
    const until = Date.now() + 60_000;
    let plans: { version: number }[] = [];
    while (!plans.length) {
      if (Date.now() > until) throw new Error(await diagnose(id));
      await new Promise((r) => setTimeout(r, 200));
      plans = (await c.request("GET", `/v1/missions/${id}/plans`)).json().plans;
    }
    let version = plans.at(-1)!.version;
    const key = PLANS[which]!.tasks[0]!.key;
    if (opts.pin) {
      const e = await c.request("POST", `/v1/missions/${id}/plans/${version}/edits`, {
        edits: [{ op: "pin", key, agentId: opts.pin }],
      });
      expect(e.statusCode, e.body).toBe(201);
      version = e.json().plan.version;
    }
    const ok = await c.request("POST", `/v1/missions/${id}/plans/${version}/approve`);
    expect(ok.statusCode, ok.body).toBe(200);
    return id;
  }

  async function waitDone(id: string, ms = 180_000) {
    const until = Date.now() + ms;
    for (;;) {
      const [m] = await h.db.db.select().from(schema.missions).where(eq(schema.missions.id, id));
      if (m?.status === "done") return;
      if (m?.status === "failed" || Date.now() > until)
        throw new Error(`mission ${m?.status}\n${await diagnose(id)}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async function made(id: string) {
    const [task] = await h.db.db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.missionId, id), gt(schema.tasks.planVersion, 0)));
    const all = await h.db.db
      .select()
      .from(schema.attempts)
      .where(eq(schema.attempts.taskId, task!.id))
      .orderBy(asc(schema.attempts.createdAt));
    const purpose = (a: (typeof all)[number]) =>
      (a.dispatch as { mode?: { purpose: string } }).mode?.purpose ?? "make";
    return {
      task: task!,
      makers: all.filter((a) => purpose(a) !== "check"),
      checkers: all.filter((a) => purpose(a) === "check"),
    };
  }

  it("a wrong fix is caught by the tests, sent back with the failure, and fixed by the second attempt", async () => {
    const id = await run("revise", { repo: seededRepo("add"), pin: agents.coder });
    await waitDone(id);
    const { task, makers } = await made(id);
    expect(task.status).toBe("done");
    expect(makers).toHaveLength(2);
    const [wrong, right] = makers;
    expect((wrong!.checks as unknown as AttemptChecks).items[0]).toMatchObject({
      kind: "tests",
      status: "failed",
    });
    expect((right!.checks as unknown as AttemptChecks).items[0]).toMatchObject({
      kind: "tests",
      status: "passed",
    });
    expect(right!.agentId).toBe(agents.coder);
    expect(wrong!.scored).toBe("revise");
    expect(right!.scored).toBe("pass");
    const events = await readEventsSince(h.db.db, id, 0, 10_000);
    const verdicts = events
      .filter((e) => e.type === "review.verdict")
      .map((e) => (e.payload as { verdict: string }).verdict);
    expect(verdicts).toEqual(["revise"]);
  }, 240_000);

  it("an agent that fails its revisions is replaced by the next-best agent, which fixes it", async () => {
    const id = await run("reroute", { repo: seededRepo("sub"), pin: agents.coder });
    await waitDone(id, 300_000);
    const { makers } = await made(id);
    expect(makers.map((a) => a.agentId === agents.coder)).toEqual([true, true, true, false]);
    expect(makers.map((a) => a.scored)).toEqual(["revise", "revise", "fail", "pass"]);
    const events = await readEventsSince(h.db.db, id, 0, 10_000);
    const verdicts = events
      .filter((e) => e.type === "review.verdict")
      .map((e) => (e.payload as { verdict: string }).verdict);
    expect(verdicts).toEqual(["revise", "revise", "reroute"]);
    const routed = events.filter((e) => e.type === "task.routed").at(-1)?.payload as {
      agents: { agentId: string }[];
    };
    expect(routed.agents[0]?.agentId).not.toBe(agents.coder);
  }, 360_000);

  it("agent checks come from another vendor; links are followed and claims checked against the fetched source", async () => {
    const id = await run("agents", { pin: agents.writer });
    await waitDone(id);
    const { makers, checkers, task } = await made(id);
    // The first answer had a dead link: link_check failed it, and the revision removed the link.
    expect(makers).toHaveLength(2);
    const first = makers[0]!.checks as unknown as AttemptChecks;
    expect(first.items.find((i) => i.kind === "link_check")).toMatchObject({ status: "failed" });
    const final = makers[1]!.checks as unknown as AttemptChecks;
    expect(final.items.map((i) => [i.kind, i.status])).toEqual([
      ["rubric_review", "passed"],
      ["fact_check", "passed"],
      ["link_check", "passed"],
      ["citation_present", "passed"],
      ["injection_scan", "passed"],
    ]);
    expect(final.items[0]?.scores).toEqual({ accurate: 5, clear: 4 });
    expect(final.items[1]?.sources?.[0]).toMatchObject({ url: "https://facts.example/connectors", ok: true });
    expect(final.items[1]?.sources?.[0]?.text).not.toContain("ignore()");
    // Every reviewer was an OpenAI agent: never the maker's vendor (Anthropic).
    expect(checkers.length).toBeGreaterThanOrEqual(2);
    expect(checkers.every((a) => a.agentId !== agents.writer)).toBe(true);
    for (const a of checkers)
      expect((a.dispatch as { agent: { connector: { presetKey: string } } }).agent.connector.presetKey).toBe(
        "openai",
      );
    const reviews = await h.db.db.select().from(schema.reviews).where(eq(schema.reviews.taskId, task.id));
    expect(reviews.filter((r) => r.kind === "review" && r.verdict === "pass").length).toBeGreaterThanOrEqual(
      2,
    );
    expect(vendors.visits).toEqual(
      expect.arrayContaining([
        "HEAD https://links.example/ok",
        "HEAD https://links.example/gone",
        "GET https://facts.example/connectors",
      ]),
    );
  }, 240_000);

  it("an accessibility audit in the web sandbox fails a page with violations; the revision passes", async () => {
    const id = await run("a11y", { pin: agents.coder });
    await waitDone(id, 600_000);
    const { makers } = await made(id);
    expect(makers).toHaveLength(2);
    const bad = (makers[0]!.checks as unknown as AttemptChecks).items[0]!;
    expect(bad.status).toBe("failed");
    expect(bad.details?.join("\n")).toMatch(/image-alt|button-name/);
    expect((makers[1]!.checks as unknown as AttemptChecks).items[0]).toMatchObject({
      kind: "a11y",
      status: "passed",
    });
  }, 900_000);
});
