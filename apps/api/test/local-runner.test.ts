// M8 acceptance (local runner): a person registers their machine in host mode (with consent), binds a coding CLI under
// their own sign-in and a project that lives there; the runner opens its socket to the API, runs the task with the
// local CLI in a fresh worktree of the local repository, checks it there, and the board sees every event. Approved,
// the branch lands in the person's repository. Here the CLI is a stand-in `agy` on PATH that speaks agy's stream-json;
// no key is involved anywhere. Needs Postgres.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEventsSince, schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { LocalRunner } from "@brio/runner";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";
import { ScriptedVendors } from "./vendors";

/** A stand-in for Google's agy: writes hello.txt where it runs and reports in agy's stream-json. */
const FAKE_AGY = `#!/bin/sh
case "$*" in *--dangerously-skip-permissions*) ;; *) echo "missing flags" >&2; exit 2 ;; esac
if [ -n "$GEMINI_API_KEY" ]; then echo "a key reached the CLI" >&2; exit 3; fi
printf 'hello from %s\\n' "$(whoami)" > hello.txt
echo '{"event":"init","conversation_id":"conv-local-1","init":{"cwd":"'"$PWD"'"}}'
echo '{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"tool","tool_name":"write_to_file","tool_info":{"name":"write_to_file","parameters":{"TargetFile":"'"$PWD"'/hello.txt"}}}}'
echo '{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"Wrote hello.txt."}}'
echo '{"event":"result","result":{"conversation_id":"conv-local-1","status":"SUCCESS","response":"Wrote hello.txt.","usage":{"input_tokens":1200,"output_tokens":80,"thinking_tokens":0,"cache_read_tokens":0}}}'
`;

const PLAN = {
  tasks: [
    {
      key: "hello",
      type: "code.feature",
      title: "Add hello.txt",
      contract: {
        objective: "Add hello.txt",
        inputs: [],
        outputs: [{ kind: "diff", description: "hello.txt" }],
        acceptance: [{ kind: "tests", command: "test -s hello.txt", hard: true }],
        constraints: [],
        expectedFootprint: { paths: ["hello.txt"] },
        sensitivity: "internal",
      },
      dependsOn: [],
      suggestedMode: "single",
    },
  ],
  assumptions: [],
  questions: [],
};

describe.skipIf(!hasTestDatabase)("M8 acceptance: a local runner", () => {
  let h: Harness;
  let c: Client;
  let base: string;
  let root: string;
  let repo: string;
  let runner: LocalRunner;
  let runnerId: string;
  let token: string;
  let agentId: string;
  let projectId: string;
  let missionId: string;
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", repo, ...a])
      .toString()
      .trim();

  beforeAll(async () => {
    h = await startHarness({ fetch: new ScriptedVendors(() => ({ text: "ok" })).fetch });
    base = await h.server.app.listen({ port: 0, host: "127.0.0.1" });
    c = new Client(h);
    await c.signIn("laptop@example.com");
    await c.request("POST", "/v1/workspaces", { name: "Laptop" });

    root = mkdtempSync(join(tmpdir(), "brio-local-runner-"));
    repo = join(root, "site");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    writeFileSync(join(repo, "README.md"), "# site\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "-m",
      "init",
    ]);
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "agy"), FAKE_AGY);
    chmodSync(join(bin, "agy"), 0o755);
    process.env.BRIO_TEST_LOCAL_BIN = bin;
  });
  afterAll(async () => {
    await runner?.stop();
    await h?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("registers a machine; host mode needs the owner's consent", async () => {
    const refused = await c.request("POST", "/v1/runners", { name: "laptop", mode: "host" });
    expect(refused.json().error).toBe("consent_required");
    const made = await c.request("POST", "/v1/runners", {
      name: "laptop",
      mode: "host",
      acceptHostMode: true,
    });
    expect(made.statusCode, made.body).toBe(201);
    token = made.json().token;
    runnerId = made.json().runner.id;
    expect(token).toMatch(/^brio_rnr_[0-9A-Za-z]{40}$/);
    expect(made.json().runner.consent.host.text).toContain("without a container");
    expect(made.json().runner.online).toBe(false);
  });

  it("binds a sign-in CLI and a project that lives on the machine; keys and other people's runners are refused", async () => {
    const claude = await c.request("POST", "/v1/connectors", {
      registryKey: "claude-code",
      localLogin: true,
    });
    expect(claude.json().error).toBe("own_use_required");
    const codex = await c.request("POST", "/v1/connectors", {
      registryKey: "openai-codex",
      localLogin: true,
    });
    expect(codex.json().error).toBe("local_login_not_allowed");
    const agy = await c.request("POST", "/v1/connectors", {
      registryKey: "google-antigravity",
      localLogin: true,
    });
    expect(agy.statusCode, agy.body).toBe(201);
    expect(agy.json().connector.health).toMatchObject({
      ok: true,
      detail: "runs under your own sign-in on a local runner",
    });
    const agent = await c.request("POST", "/v1/agents", {
      connectorId: agy.json().connector.id,
      name: "agy on my laptop",
      model: "gemini-3-pro",
      runnerId,
    });
    expect(agent.statusCode, agent.body).toBe(201);
    expect(agent.json().agent).toMatchObject({ runnerId, localLogin: true, runnable: true });
    agentId = agent.json().agent.id;
    const project = await c.request("POST", "/v1/projects", {
      name: "site",
      repoUrl: repo,
      defaultBranch: "main",
      runnerId,
    });
    expect(project.statusCode, project.body).toBe(201);
    projectId = project.json().project.id;
  });

  it("waits for the runner, then runs the task on it with the local CLI, checks it there, and the board sees it", async () => {
    const m = await c.request("POST", "/v1/missions", {
      goal: "Say hello",
      plan: PLAN,
      projectId,
      routing: { strategy: "single", agentId },
    });
    missionId = m.json().mission.id;
    expect((await c.request("POST", `/v1/missions/${missionId}/plans/1/approve`)).statusCode).toBe(200);
    // Queued for the runner, which is not connected yet: the cloud runner leaves it alone.
    let queued: typeof schema.attempts.$inferSelect | undefined;
    for (let i = 0; i < 150 && !queued; i++) {
      await new Promise((r) => setTimeout(r, 100));
      [queued] = await h.db.db.select().from(schema.attempts).where(eq(schema.attempts.agentId, agentId));
    }
    await new Promise((r) => setTimeout(r, 1500));
    [queued] = await h.db.db.select().from(schema.attempts).where(eq(schema.attempts.agentId, agentId));
    expect(queued?.status).toBe("queued");
    expect((queued?.dispatch as { target?: unknown } | undefined)?.target).toEqual({
      kind: "local",
      runnerId,
      mode: "host",
    });

    runner = new LocalRunner({
      url: base,
      token,
      dir: join(root, "runner"),
      log: { debug() {}, info() {}, warn() {}, error() {} },
      env: {
        ...process.env,
        PATH: `${process.env.BRIO_TEST_LOCAL_BIN}:${process.env.PATH}`,
        GEMINI_API_KEY: "",
      },
      capabilities: {
        clis: [{ key: "antigravity", version: "fake 1.0" }],
        docker: false,
        os: "test",
        version: "test",
      },
      reconnectMs: 200,
    });
    await runner.start();
    expect((await c.request("GET", "/v1/runners")).json().runners[0]).toMatchObject({
      online: true,
      capabilities: { clis: [{ key: "antigravity" }] },
    });

    for (let i = 0; i < 300; i++) {
      const [row] = await h.db.db.select().from(schema.missions).where(eq(schema.missions.id, missionId));
      if (row?.status === "done") break;
      if (row?.status === "failed") throw new Error(`mission failed: ${row.blockedReason}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    const [attempt] = await h.db.db
      .select()
      .from(schema.attempts)
      .where(eq(schema.attempts.agentId, agentId));
    expect(attempt).toMatchObject({ status: "succeeded", runnerId: `local:${runnerId}`, costUsd: 0 });
    expect(attempt?.transcriptRef).toBe("conv-local-1");
    const items =
      (attempt?.checks as { items: Array<{ kind: string; status: string; summary: string }> } | undefined)
        ?.items ?? [];
    expect(items.find((i) => i.kind === "tests")).toMatchObject({
      status: "passed",
      summary: "test -s hello.txt exited 0",
    });

    const events = await readEventsSince(h.db.db, missionId, 0, 1000);
    const started = events.find((e) => e.type === "attempt.started");
    expect(started?.payload).toMatchObject({ runner: "local runner laptop", route: "cli" });
    expect(
      events.some(
        (e) => e.type === "attempt.tool_call" && JSON.stringify(e.payload).includes("write_to_file"),
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === "attempt.file_edit" && e.payload.path === "hello.txt")).toBe(true);
    expect(events.some((e) => e.type === "check.result" && e.payload.passed === true)).toBe(true);
    expect(events.at(-2)?.type === "mission.done" || events.some((e) => e.type === "mission.done")).toBe(
      true,
    );

    // The diff is on the board, as from any runner.
    const diff = await h.db.db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.attemptId, attempt!.id));
    expect(diff.map((a) => a.kind)).toContain("diff");
  }, 90_000);

  it("delivers the branch into the person's repository once approved", async () => {
    const view = (await c.request("GET", `/v1/missions/${missionId}`)).json();
    expect(view.deliveries).toHaveLength(1);
    const d = view.deliveries[0];
    expect(d).toMatchObject({ kind: "branch", status: "awaiting_approval" });
    expect(
      (await c.request("POST", `/v1/approvals/${d.approvalId}/decide`, { decision: "approve" })).statusCode,
    ).toBe(200);
    let status = "";
    for (let i = 0; i < 100 && status !== "done" && status !== "failed"; i++) {
      status = (await c.request("GET", `/v1/missions/${missionId}/deliveries`)).json().deliveries[0].status;
      if (status !== "done") await new Promise((r) => setTimeout(r, 150));
    }
    expect(status).toBe("done");
    expect(git("show", `${d.branch}:hello.txt`)).toMatch(/^hello from /);
    // Never into the person's checkout: main is where it was.
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git("ls-files")).toBe("README.md");
  }, 30_000);

  it("takes work only from its owner: their mission, a plan version they approved", async () => {
    const [p] = await h.db.db.select().from(schema.projects).where(eq(schema.projects.id, projectId));
    const workspaceId = p!.workspaceId;
    const other = new Client(h);
    await other.signIn("colleague@example.com");
    const inv = await c.request("POST", `/v1/workspaces/${workspaceId}/invitations`, {
      email: "colleague@example.com",
      role: "member",
    });
    expect(inv.statusCode, inv.body).toBe(201);
    await other.request("POST", "/api/auth/organization/accept-invitation", {
      invitationId: inv.json().invitation.id,
    });
    const as = (who: Client, method: "POST", url: string, body?: unknown) =>
      who.request(method, url, body, { "x-brio-workspace": workspaceId });
    const blockedTask = async (id: string) => {
      for (let i = 0; i < 100; i++) {
        const [t] = await h.db.db.select().from(schema.tasks).where(eq(schema.tasks.missionId, id));
        if (t?.status === "blocked") return t;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("the task was not blocked");
    };
    const mission = async (who: Client, approver: Client) => {
      const m = await as(who, "POST", "/v1/missions", {
        goal: "Say hello",
        plan: PLAN,
        projectId,
        routing: { strategy: "single", agentId },
      });
      expect(m.statusCode, m.body).toBe(201);
      const id = m.json().mission.id as string;
      expect((await as(approver, "POST", `/v1/missions/${id}/plans/1/approve`)).statusCode).toBe(200);
      return id;
    };

    // A colleague's mission on the owner's machine.
    const theirs = await blockedTask(await mission(other, other));
    expect(theirs.blockedReason).toContain("only they start work there (this mission is someone else's)");
    // The owner's mission, on a plan someone else approved.
    const unapproved = await blockedTask(await mission(c, other));
    expect(unapproved.blockedReason).toContain("they did not approve this version of the plan");
    // Neither ever reached the machine.
    for (const t of [theirs, unapproved])
      expect(await h.db.db.select().from(schema.attempts).where(eq(schema.attempts.taskId, t.id))).toEqual(
        [],
      );
  }, 60_000);

  it("a revoked runner is cut off", async () => {
    expect((await c.request("DELETE", `/v1/runners/${runnerId}`)).statusCode).toBe(204);
    await new Promise((r) => setTimeout(r, 500));
    expect((await c.request("GET", "/v1/runners")).json().runners).toEqual([]);
  });
});
