// M9 acceptance (memory): a mission on a project changes src/health.ts; afterwards the brief for that file holds the
// decisions behind the change (the plan's assumption, the person's answer), its contract and the prompt the agent was
// given. The next mission's agent gets that brief before it starts. People can add, correct and forget items, and
// each change is in the ledger. Needs Postgres and Docker.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { dockerAvailable } from "@brio/runner";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";
import { type CallInfo, ScriptedVendors, taskTitle } from "./vendors";

const hasDocker = await dockerAvailable();
const OPENAI_KEY = ["sk", "proj", "memory0123456789abcdefghi"].join("-");

const codeTask = (key: string, title: string, path: string) => ({
  key,
  type: "code.feature",
  title,
  contract: {
    objective: `${title} in ${path}`,
    inputs: [],
    outputs: [{ kind: "diff", description: path }],
    acceptance: [{ kind: "tests", command: `test -f ${path}`, hard: true }],
    constraints: ["Answer with JSON"],
    expectedFootprint: { paths: [path] },
    sensitivity: "internal",
  },
  dependsOn: [],
  suggestedMode: "single",
});

describe.skipIf(!hasTestDatabase || !hasDocker)("M9 acceptance: project memory", () => {
  const vendors = new ScriptedVendors((call: CallInfo) => {
    const title = taskTitle(call.body) ?? "";
    if (call.turn > 1) return { text: `Done: ${title}.` };
    if (title === "Add the health check")
      return {
        tools: [
          { name: "write_file", args: { path: "src/health.ts", content: "export const ok = true;\n" } },
        ],
      };
    if (title === "Report uptime")
      return {
        tools: [
          {
            name: "write_file",
            args: { path: "src/health.ts", content: "export const ok = true;\nexport const up = 1;\n" },
          },
        ],
      };
    return { text: "?" };
  });
  let h: Harness;
  let c: Client;
  let agentId: string;
  let projectId: string;
  let root: string;

  beforeAll(async () => {
    h = await startHarness({ fetch: vendors.fetch });
    c = new Client(h);
    await c.signIn("memory@example.com");
    await c.request("POST", "/v1/workspaces", { name: "Memory" });
    const openai = (
      await c.request("POST", "/v1/connectors", { registryKey: "openai-api", apiKey: OPENAI_KEY })
    ).json().connector;
    agentId = (
      await c.request("POST", "/v1/agents", {
        connectorId: openai.id,
        name: "coder",
        model: "gpt-coder",
        priceOverride: { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null },
      })
    ).json().agent.id;
    root = mkdtempSync(join(tmpdir(), "brio-memory-"));
    const git = (...a: string[]) =>
      execFileSync("git", ["-C", root, ...a], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    writeFileSync(join(root, "README.md"), "# svc\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    projectId = (
      await c.request("POST", "/v1/projects", { name: "svc", repoUrl: root, defaultBranch: "main" })
    ).json().project.id;
  });
  afterAll(async () => {
    await h?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function runToEnd(goal: string, task: ReturnType<typeof codeTask>, assumptions: string[]) {
    const m = await c.request("POST", "/v1/missions", {
      goal,
      projectId,
      plan: { tasks: [task], assumptions, questions: [] },
      routing: { strategy: "single", agentId },
    });
    const id = m.json().mission.id as string;
    expect((await c.request("POST", `/v1/missions/${id}/plans/1/approve`)).statusCode).toBe(200);
    for (let i = 0; i < 400; i++) {
      const [row] = await h.db.db.select().from(schema.missions).where(eq(schema.missions.id, id));
      if (row?.status === "done") break;
      if (row?.status === "failed") throw new Error(`mission failed: ${row.blockedReason}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    await h.server.ctx.memory.idle();
    return id;
  }

  it("remembers the decisions, contract and prompt behind a file's change", async () => {
    const missionId = await runToEnd(
      "Add a health check",
      codeTask("health", "Add the health check", "src/health.ts"),
      ["The service stays on Node 22"],
    );
    // A person's answer to the agent's question is a decision too.
    const [t] = await h.db.db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.missionId, missionId), eq(schema.tasks.key, "health")));
    const [a] = await h.db.db.select().from(schema.attempts).where(eq(schema.attempts.taskId, t!.id));
    const [q] = await h.db.db
      .insert(schema.messages)
      .values({
        workspaceId: t!.workspaceId,
        missionId,
        fromAttemptId: a!.id,
        toUser: true,
        kind: "question",
        body: "Should health return JSON?",
      })
      .returning();
    expect(
      (await c.request("POST", `/v1/messages/${q!.id}/answer`, { text: "Yes, always JSON." })).statusCode,
    ).toBe(201);
    for (let i = 0; i < 50; i++) {
      await h.server.ctx.memory.idle();
      const n = await h.db.db
        .select()
        .from(schema.memoryNodes)
        .where(eq(schema.memoryNodes.ref, `answer:${q!.id}`));
      if (n.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const res = await c.request("GET", `/v1/projects/${projectId}/brief?paths=src/health.ts`);
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json().items as Array<{ kind: string; title: string; body: string; via?: string }>;
    const kinds = new Set(items.map((i) => i.kind));
    for (const k of ["decision", "contract", "prompt", "task"]) expect(kinds, k).toContain(k);
    expect(
      items.find((i) => i.kind === "decision" && i.title === "Assumed: The service stays on Node 22")?.via,
    ).toBe("src/health.ts");
    expect(
      items.some(
        (i) => i.kind === "decision" && i.body === "Q: Should health return JSON?\nA: Yes, always JSON.",
      ),
    ).toBe(true);
    expect(items.find((i) => i.kind === "contract")?.body).toContain("Add the health check in src/health.ts");
    expect(items.find((i) => i.kind === "prompt")?.body).toContain("Add the health check");
    // By topic too.
    const topic = (await c.request("GET", `/v1/projects/${projectId}/brief?topic=Node`)).json();
    expect(topic.items.some((i: { title: string }) => i.title.includes("Node 22"))).toBe(true);
  }, 200_000);

  it("gives the next mission's agent that brief before it starts", async () => {
    const id = await runToEnd("Report uptime", codeTask("uptime", "Report uptime", "src/health.ts"), []);
    const [a] = await h.db.db
      .select({ d: schema.attempts.dispatch })
      .from(schema.attempts)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.attempts.taskId))
      .where(eq(schema.tasks.missionId, id));
    const d = a?.d as {
      input: { brief: { summary: string } };
      files: Array<{ path: string; content: string }>;
    };
    expect(d.input.brief.summary).toContain("Assumed: The service stays on Node 22");
    expect(d.input.brief.summary).toContain("Yes, always JSON.");
    expect(d.files.find((f) => f.path === "brief.md")?.content).toContain("# Project memory");
    // The agent's prompt carries it (model-API agents get it in the conversation).
    const call = vendors.calls.find((x) => x.body.includes("Report uptime"));
    expect(call?.body).toContain("Project memory");
  }, 200_000);

  it("lets people add, correct and forget what the project remembers", async () => {
    const pref = await c.request("POST", `/v1/projects/${projectId}/memory`, {
      kind: "preference",
      title: "Use pnpm, never npm",
    });
    expect(pref.statusCode, pref.body).toBe(201);
    const list = (await c.request("GET", `/v1/projects/${projectId}/memory?kind=decision`)).json().items;
    const assumption = list.find((n: { title: string }) => n.title.startsWith("Assumed:"));
    await c.request("PATCH", `/v1/memory/${assumption.id}`, {
      title: "Assumed: The service stays on Node 24",
    });
    let brief = (await c.request("GET", `/v1/projects/${projectId}/brief?paths=src/health.ts`)).json();
    expect(brief.summary).toContain("Node 24");
    expect(brief.summary).toContain("Use pnpm, never npm");
    expect((await c.request("DELETE", `/v1/memory/${assumption.id}`)).statusCode).toBe(204);
    brief = (await c.request("GET", `/v1/projects/${projectId}/brief?paths=src/health.ts`)).json();
    expect(brief.summary).not.toContain("Node 2");
    const ledger = await h.db.db.select().from(schema.ledger).where(eq(schema.ledger.kind, "memory.change"));
    expect(ledger.map((l) => (l.payload as { change: string }).change)).toEqual([
      "added",
      "edited",
      "forgotten",
    ]);
  });
});
