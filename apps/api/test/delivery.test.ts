// M8 acceptance (the PR action): a mission on a repository ends with its work integrated, and Brio asks before handing
// it back. The ask is in the inbox; a person denies it, asks again and approves; only then does a runner push the
// integration commit as a branch (with the project's token, from the vault) and open the pull request on GitHub (a
// fake here, on the real REST shape). The token is in no event, no dispatch and no response, and every decision and
// side effect is in the audit ledger. Needs Postgres and Docker.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEventsSince, schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { dockerAvailable } from "@brio/runner";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";
import { type CallInfo, type Reply, ScriptedVendors, taskTitle } from "./vendors";

const hasDocker = await dockerAvailable();
const OPENAI_KEY = ["sk", "proj", "deliver0123456789abcdefgh"].join("-");
const GIT_TOKEN = ["github", "pat", "11DELIVER0123456789abcdefghijklmnop"].join("_");

const PLAN = {
  tasks: [
    {
      key: "health",
      type: "code.feature",
      title: "Add the health file",
      contract: {
        objective: "Add health.txt saying ok",
        inputs: [],
        outputs: [{ kind: "diff", description: "health.txt" }],
        acceptance: [{ kind: "tests", command: "test -f health.txt", hard: true }],
        constraints: [],
        expectedFootprint: { paths: ["health.txt"] },
        sensitivity: "internal",
      },
      dependsOn: [],
      suggestedMode: "single",
      estimate: { usd: 0.01, minutes: 1 },
    },
  ],
  assumptions: [],
  questions: [],
};

function script(call: CallInfo): Reply {
  if (taskTitle(call.body) !== "Add the health file") return { text: "?" };
  if (call.turn === 1)
    return { tools: [{ name: "write_file", args: { path: "health.txt", content: "ok\n" } }] };
  return { text: "Added health.txt." };
}

interface GithubCall {
  method: string;
  path: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

describe.skipIf(!hasTestDatabase || !hasDocker)("M8 acceptance: approve the PR action", () => {
  const vendors = new ScriptedVendors(script);
  const github: GithubCall[] = [];
  let h: Harness;
  let c: Client;
  let remote: string;
  let workspaceId: string;
  let missionId: string;
  const dirs: string[] = [];

  beforeAll(async () => {
    h = await startHarness({
      fetch: async (input, init) => {
        const url = String(input);
        if (!url.startsWith("https://api.github.com/")) return vendors.fetch(input, init);
        const headers = new Headers(init?.headers);
        github.push({
          method: init?.method ?? "GET",
          path: url.replace("https://api.github.com", ""),
          auth: headers.get("authorization"),
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(JSON.stringify({ html_url: "https://github.com/acme/site/pull/7", number: 7 }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    });
    c = new Client(h);
    await c.signIn("deliver@example.com");
    workspaceId = (await c.request("POST", "/v1/workspaces", { name: "Deliver" })).json().workspace.id;

    // The "GitHub" repository, reachable by path; pull requests for it go to acme/site.
    const root = mkdtempSync(join(tmpdir(), "brio-deliver-"));
    dirs.push(root);
    remote = join(root, "site.git");
    const seed = join(root, "seed");
    const git = (...a: string[]) =>
      execFileSync("git", a, {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      })
        .toString()
        .trim();
    git("init", "--bare", "-q", "-b", "main", remote);
    git("clone", "-q", remote, seed);
    git("-C", seed, "commit", "-q", "--allow-empty", "-m", "init");
    git("-C", seed, "push", "-q", "origin", "HEAD:main");
  });
  afterAll(async () => {
    await h?.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const git = (...a: string[]) =>
    execFileSync("git", ["--git-dir", remote, ...a])
      .toString()
      .trim();

  it("keeps the project's git token in the vault: never returned, only whether there is one", async () => {
    const openai = (
      await c.request("POST", "/v1/connectors", { registryKey: "openai-api", apiKey: OPENAI_KEY })
    ).json().connector;
    const price = { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null };
    const agent = (
      await c.request("POST", "/v1/agents", {
        connectorId: openai.id,
        name: "coder",
        model: "gpt-coder",
        priceOverride: price,
      })
    ).json().agent;

    const p = await c.request("POST", "/v1/projects", {
      name: "site",
      repoUrl: remote,
      defaultBranch: "main",
      gitToken: GIT_TOKEN,
      githubRepo: "acme/site",
    });
    expect(p.statusCode, p.body).toBe(201);
    expect(p.json().project).toMatchObject({ hasToken: true, githubRepo: "acme/site" });
    expect(p.body).not.toContain(GIT_TOKEN);
    expect((await c.request("GET", "/v1/projects")).body).not.toContain(GIT_TOKEN);

    const m = await c.request("POST", "/v1/missions", {
      goal: "Add a health file",
      plan: PLAN,
      projectId: p.json().project.id,
      routing: { strategy: "single", agentId: agent.id },
    });
    missionId = m.json().mission.id;
    expect((await c.request("POST", `/v1/missions/${missionId}/plans/1/approve`)).statusCode).toBe(200);
    for (let i = 0; i < 600; i++) {
      const [row] = await h.db.db.select().from(schema.missions).where(eq(schema.missions.id, missionId));
      if (row?.status === "done") break;
      if (row?.status === "failed") throw new Error(`mission failed: ${row.blockedReason}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }, 200_000);

  it("asks before pushing: the pull request waits in the inbox, and nothing reaches the repository", async () => {
    const view = (await c.request("GET", `/v1/missions/${missionId}`)).json();
    expect(view.mission.status).toBe("done");
    // The board's view of the work: the merge that passed, and the file lease the task held (released now).
    expect(view.integration).toMatchObject({ status: "passed", round: 1 });
    expect(view.leases).toContainEqual(
      expect.objectContaining({ taskKey: "health", resource: "health.txt", releasedAt: expect.any(String) }),
    );
    expect(view.deliveries).toHaveLength(1);
    expect(view.deliveries[0]).toMatchObject({
      kind: "pull_request",
      status: "awaiting_approval",
      repo: { url: remote, base: "main" },
      title: "Add a health file",
    });
    expect(view.deliveries[0].branch).toMatch(/^brio\/add-a-health-file-[0-9a-f]{8}$/);
    const inbox = (await c.request("GET", "/v1/inbox")).json().items as Array<Record<string, unknown>>;
    expect(inbox).toContainEqual(
      expect.objectContaining({
        kind: "action",
        missionId,
        action: "open_pull_request",
        requestedBy: "brio",
      }),
    );
    expect(git("branch", "--list", "brio/*")).toBe("");
    expect(github).toEqual([]);
  });

  it("an API token cannot decide it; a person can deny it, and ask again", async () => {
    const [d] = (await c.request("GET", `/v1/missions/${missionId}/deliveries`)).json().deliveries;
    const token = (await c.request("POST", "/v1/tokens", { name: "agent" })).json().token.value as string;
    const robot = new Client(h);
    const refused = await robot.request(
      "POST",
      `/v1/approvals/${d.approvalId}/decide`,
      { decision: "approve" },
      { authorization: `Bearer ${token}` },
    );
    expect(refused.statusCode).toBe(403);

    const denied = await c.request("POST", `/v1/approvals/${d.approvalId}/decide`, {
      decision: "deny",
      reason: "not yet",
    });
    expect(denied.statusCode, denied.body).toBe(200);
    expect(denied.json()).toMatchObject({ approval: { status: "denied" }, delivery: { status: "denied" } });
    const again = await c.request("POST", `/v1/approvals/${d.approvalId}/decide`, { decision: "approve" });
    expect(again.statusCode).toBe(409);
    expect((await c.request("GET", "/v1/inbox")).json().count).toBe(0);

    const asked = await c.request("POST", `/v1/missions/${missionId}/deliveries`);
    expect(asked.statusCode, asked.body).toBe(201);
    expect((await c.request("POST", `/v1/missions/${missionId}/deliveries`)).statusCode).toBe(409);
  });

  it("approved, a runner pushes the branch and opens the pull request as the token's owner", async () => {
    const all = (await c.request("GET", `/v1/missions/${missionId}/deliveries`)).json().deliveries;
    const d = all.at(-1);
    const ok = await c.request("POST", `/v1/approvals/${d.approvalId}/decide`, { decision: "approve" });
    expect(ok.json().delivery.status).toBe("queued");
    let done: Record<string, unknown> | undefined;
    for (let i = 0; i < 200; i++) {
      const rows = (await c.request("GET", `/v1/missions/${missionId}/deliveries`)).json().deliveries;
      done = rows.at(-1);
      if (done?.status === "done" || done?.status === "failed") break;
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(done, JSON.stringify(done)).toMatchObject({
      status: "done",
      url: "https://github.com/acme/site/pull/7",
      number: 7,
    });

    // The branch is on the repository, holding the mission's work on top of main.
    expect(git("rev-parse", `refs/heads/${d.branch}`)).toBe(d.commit);
    expect(git("show", `${d.branch}:health.txt`)).toBe("ok");
    expect(git("merge-base", "--is-ancestor", "main", d.branch)).toBe("");

    expect(github).toHaveLength(1);
    expect(github[0]).toMatchObject({
      method: "POST",
      path: "/repos/acme/site/pulls",
      auth: `Bearer ${GIT_TOKEN}`,
      body: { title: "Add a health file", head: d.branch, base: "main" },
    });
    expect(String(github[0]?.body?.body)).toContain("Add the health file");

    // Events tell the story; the token is in none of them, nor in any dispatch.
    const events = await readEventsSince(h.db.db, missionId, 0, 10_000);
    const types = events.map((e) => e.type);
    for (const t of ["approval.requested", "approval.decided", "delivery.started", "delivery.done"])
      expect(types).toContain(t);
    expect(JSON.stringify(events)).not.toContain(GIT_TOKEN);
    const attempts = await h.db.db
      .select()
      .from(schema.attempts)
      .where(eq(schema.attempts.workspaceId, workspaceId));
    expect(JSON.stringify(attempts.map((a) => a.dispatch))).not.toContain(GIT_TOKEN);

    // The ledger has both decisions and both side effects.
    const ledger = await h.db.db
      .select()
      .from(schema.ledger)
      .where(eq(schema.ledger.workspaceId, workspaceId));
    const decisions = ledger.filter((l) => l.kind === "approval.decision");
    expect(decisions.map((l) => (l.payload as { decision: string }).decision)).toEqual([
      "denied",
      "approved",
    ]);
    const effects = ledger
      .filter((l) => l.kind === "side_effect")
      .map((l) => (l.payload as { action: string }).action);
    expect(effects).toEqual(["git.push", "github.pull_request"]);
    expect(JSON.stringify(ledger)).not.toContain(GIT_TOKEN);
  }, 60_000);
});
