// M5 acceptance (merge engine): when every task is done, the code branches are merged in plan order onto one
// integration branch and every hard check runs on the result. A conflict becomes a merge.integrate task; merged work
// that fails becomes a fix task; and a task whose upstream branches conflict waits for a merge task instead of failing.
// Needs Postgres and Docker.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEventsSince, schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { dockerAvailable } from "@brio/runner";
import { and, asc, eq, gt } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";
import { type CallInfo, type Reply, ScriptedVendors, taskTitle } from "./vendors";

const hasDocker = await dockerAvailable();
const OPENAI_KEY = ["sk", "proj", "integrate0123456789abcdef"].join("-");
const ANTHROPIC_KEY = ["sk", "ant", "api03", "integrate0123456789abcdef"].join("-");

const ok = "node -e 'process.exit(0)'";
const code = (
  key: string,
  title: string,
  footprint: string[],
  command: string,
  dependsOn: string[] = [],
) => ({
  key,
  type: "code.feature",
  title,
  contract: {
    objective: title,
    inputs: [],
    outputs: [{ kind: "diff", description: title }],
    acceptance: [{ kind: "tests", command, hard: true }],
    constraints: [],
    expectedFootprint: { paths: footprint },
    sensitivity: "internal",
  },
  dependsOn,
  suggestedMode: "single",
  estimate: { usd: 0.01, minutes: 1 },
});
const graph = (...tasks: ReturnType<typeof code>[]) => ({ tasks, assumptions: [], questions: [] });

const MODE_X = `node -e "import('./config.mjs').then((m) => process.exit(m.mode === 'x' ? 0 : 1))"`;
const PLANS: Record<string, ReturnType<typeof graph>> = {
  conflict: graph(
    code("left", "Write the left half", ["left/**"], ok),
    code("right", "Write the right half", ["right/**"], ok),
  ),
  fails: graph(
    code("mode", "Switch the mode to x", ["config.mjs"], MODE_X),
    code("guard", "Add the mode guard test", ["check/**"], "node --test 'check/*.test.mjs'"),
  ),
  upstream: graph(
    code("left", "Write the left half", ["left/**"], ok),
    code("right", "Write the right half", ["right/**"], ok),
    code("summary", "Write the summary", ["summary/**"], "test -f summary/done.txt", ["left", "right"]),
  ),
};

const write = (path: string, content: string): Reply => ({
  tools: [{ name: "write_file", args: { path, content } }],
});
const text = (t: string): Reply => ({ text: t });

function script(call: CallInfo): Reply {
  const { body, turn } = call;
  if (body.includes("# Plan this mission")) {
    const which = /case:([a-z]+)/.exec(body)?.[1] ?? "";
    return text(`\`\`\`json\n${JSON.stringify(PLANS[which])}\n\`\`\``);
  }
  const title = taskTitle(body) ?? "";
  if (turn > 1) return text(`Done: ${title}.`);
  switch (title) {
    // Both halves also write shared.txt (outside their footprints): the branches conflict when merged.
    case "Write the left half":
      return write("shared.txt", "left\n");
    case "Write the right half":
      return write("shared.txt", "right\n");
    case "Resolve the merge conflicts":
    case "Merge the work summary builds on":
      return write("shared.txt", "left and right\n");
    case "Switch the mode to x":
      return write("config.mjs", 'export const mode = "x";\n');
    case "Add the mode guard test":
      // Right on its own base (mode is "y" there), wrong once the mode task is merged.
      return write(
        "check/mode.test.mjs",
        'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { mode } from "../config.mjs";\ntest("mode", () => assert.ok(["y"].includes(mode)));\n',
      );
    case "Make the integrated work pass its checks":
      return write(
        "check/mode.test.mjs",
        'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { mode } from "../config.mjs";\ntest("mode", () => assert.ok(["x", "y"].includes(mode)));\n',
      );
    case "Write the summary":
      return write("summary/done.txt", "summary\n");
    default:
      return text(`unexpected: ${title}`);
  }
}

describe.skipIf(!hasTestDatabase || !hasDocker)("M5 acceptance: the merge engine", () => {
  const vendors = new ScriptedVendors(script);
  let h: Harness;
  let c: Client;
  let planner: string;
  const repos: string[] = [];

  beforeAll(async () => {
    h = await startHarness({ fetch: vendors.fetch });
    c = new Client(h);
    await c.signIn("merge@example.com");
    await c.request("POST", "/v1/workspaces", { name: "Merge" });
    const openai = (
      await c.request("POST", "/v1/connectors", { registryKey: "openai-api", apiKey: OPENAI_KEY })
    ).json().connector;
    const anthropic = (
      await c.request("POST", "/v1/connectors", { registryKey: "claude-api", apiKey: ANTHROPIC_KEY })
    ).json().connector;
    const price = { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null };
    for (const [name, connectorId, model] of [
      ["planner", openai.id, "planner"],
      ["writer", anthropic.id, "claude-writer"],
    ] as const) {
      const r = await c.request("POST", "/v1/agents", { connectorId, name, model, priceOverride: price });
      if (name === "planner") planner = r.json().agent.id;
    }
  });
  afterAll(async () => {
    await h?.close();
    for (const r of repos) rmSync(r, { recursive: true, force: true });
  });

  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), "brio-merge-"));
    repos.push(dir);
    writeFileSync(join(dir, "config.mjs"), 'export const mode = "y";\n');
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
    git("commit", "-q", "-m", "init");
    return dir;
  }

  const diagnose = async (id: string) => {
    const ts = await h.db.db.select().from(schema.tasks).where(eq(schema.tasks.missionId, id));
    const ints = await h.db.db
      .select()
      .from(schema.integrations)
      .where(eq(schema.integrations.missionId, id));
    return [
      ...ts.map((t) => `${t.key}: ${t.status} ${t.blockedReason ?? ""}`),
      ...ints.map(
        (i) =>
          `integration r${i.round}: ${i.status} ${JSON.stringify(i.conflicts)} ${JSON.stringify(i.checks.map((x) => [x.command, x.passed]))} ${i.error ?? ""}`,
      ),
    ].join("\n");
  };

  async function run(which: string) {
    const p = await c.request("POST", "/v1/projects", {
      name: which,
      repoUrl: repo(),
      defaultBranch: "main",
    });
    const res = await c.request("POST", "/v1/missions", {
      goal: `Exercise case:${which}`,
      plannerAgentId: planner,
      priority: "fast",
      projectId: p.json().project.id,
    });
    const id = res.json().mission.id as string;
    const until = Date.now() + 300_000;
    let approved = false;
    for (;;) {
      const [m] = await h.db.db.select().from(schema.missions).where(eq(schema.missions.id, id));
      if (m?.status === "awaiting_approval" && !approved) {
        expect((await c.request("POST", `/v1/missions/${id}/plans/1/approve`)).statusCode).toBe(200);
        approved = true;
      }
      if (m?.status === "done") return id;
      if (m?.status === "failed" || Date.now() > until)
        throw new Error(`mission ${m?.status}\n${await diagnose(id)}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  const rounds = (id: string) =>
    h.db.db
      .select()
      .from(schema.integrations)
      .where(eq(schema.integrations.missionId, id))
      .orderBy(asc(schema.integrations.round));
  const planned = (id: string) =>
    h.db.db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.missionId, id), gt(schema.tasks.planVersion, 0)))
      .orderBy(asc(schema.tasks.createdAt));

  it("turns a conflict between finished branches into a merge task, then integrates its result", async () => {
    const id = await run("conflict");
    const ints = await rounds(id);
    expect(ints.map((i) => i.status)).toEqual(["conflict", "passed"]);
    expect(ints[0]?.conflicts[0]?.files).toEqual(["shared.txt"]);
    expect(ints[0]?.conflicts[0]?.between.slice().sort()).toEqual(["left", "right"]);
    const ts = await planned(id);
    const merge = ts.find((t) => t.key === "merge.integrate-r1");
    expect(merge).toMatchObject({ type: "merge.integrate", status: "done" });
    expect(ints[1]?.refs.map((r) => r.taskKey)).toEqual(["merge.integrate-r1"]);
    const events = await readEventsSince(h.db.db, id, 0, 10_000);
    const done = events.find((e) => e.type === "mission.done")?.payload as {
      integration?: { branch: string };
    };
    expect(done.integration?.branch).toBe(ints[1]?.branch);
    expect(events.some((e) => e.type === "merge.conflict")).toBe(true);

    // The final report: what was done, by whom, the integration, and nothing left open.
    const res = await c.request("GET", `/v1/missions/${id}/report`);
    expect(res.statusCode, res.body).toBe(200);
    const { report, final } = res.json() as {
      final: boolean;
      report: {
        status: string;
        tasks: { key: string; agent: string | null }[];
        integration: { status: string };
        openIssues: unknown[];
      };
    };
    expect(final).toBe(true);
    expect(report.status).toBe("done");
    expect(report.tasks.map((t) => t.key)).toEqual(["left", "right", "merge.integrate-r1"]);
    expect(report.tasks.every((t) => t.agent)).toBe(true);
    expect(report.integration.status).toBe("passed");
    expect(report.openIssues).toEqual([]);
    const md = await c.request("GET", `/v1/missions/${id}/report?format=md`);
    expect(md.headers["content-type"]).toContain("text/markdown");
    expect(md.body).toContain("## Integration");
    expect(md.body).toContain("Resolve the merge conflicts (`merge.integrate-r1`)");
  }, 400_000);

  it("runs every task's checks on the merged result; a failure there becomes a fix task", async () => {
    const id = await run("fails");
    const ints = await rounds(id);
    expect(ints.map((i) => i.status)).toEqual(["failed", "passed"]);
    expect(ints[0]?.checks.map((x) => [x.command, x.passed])).toEqual([
      [MODE_X, true],
      ["node --test 'check/*.test.mjs'", false],
    ]);
    expect(ints[0]?.branch).toMatch(/integration-v1-r1$/);
    const ts = await planned(id);
    expect(ts.find((t) => t.key === "integration.fix-r1")).toMatchObject({
      type: "code.bugfix",
      status: "done",
    });
    const events = await readEventsSince(h.db.db, id, 0, 10_000);
    expect(events.filter((e) => e.type === "merge.started")).toHaveLength(1);
    const diff = await h.db.db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, ints[0]!.diffArtifactId!));
    expect((diff[0]?.meta as { integrationId?: string } | undefined)?.integrationId).toBe(ints[0]?.id);
  }, 400_000);

  it("merges conflicting upstream work before the task that builds on it starts", async () => {
    const id = await run("upstream");
    const ts = await planned(id);
    const merge = ts.find((t) => t.key === "merge.integrate-summary");
    expect(merge).toMatchObject({ status: "done" });
    const summary = ts.find((t) => t.key === "summary");
    expect(summary?.status).toBe("done");
    expect(summary?.dependsOn).toContain(merge?.id);
    const ints = await rounds(id);
    expect(ints.at(-1)?.status).toBe("passed");
    expect(ints.at(-1)?.refs.map((r) => r.taskKey)).toEqual(["merge.integrate-summary", "summary"]);
  }, 400_000);
});
