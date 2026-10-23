// M8 (PRD F1): a mission starts from more than its goal — an issue link, read once with the project's token when the
// project is that repository, and attached files. Every attempt gets them as attachments and as .brio/inputs/ files;
// binaries go to worktrees only. Needs Postgres.
import { schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";

const OPENAI_KEY = ["sk", "proj", "inputs0123456789abcdefghi"].join("-");
const GIT_TOKEN = ["github", "pat", "11INPUTS0123456789abcdefghijklmnopq"].join("_");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const PLAN = {
  tasks: [
    {
      key: "spec",
      type: "write.doc",
      title: "Write the spec",
      contract: {
        objective: "Spec the fix for the issue",
        inputs: [],
        outputs: [{ kind: "doc", description: "the spec" }],
        acceptance: [{ kind: "diff_scope", hard: true }],
        constraints: [],
        sensitivity: "internal",
      },
      dependsOn: [],
      suggestedMode: "single",
    },
  ],
  assumptions: [],
  questions: [],
};

describe.skipIf(!hasTestDatabase)("M8: mission inputs", () => {
  const github: Array<{ path: string; auth: string | null }> = [];
  let h: Harness;
  let c: Client;
  let agentId: string;
  let projectId: string;

  beforeAll(async () => {
    h = await startHarness({
      runner: false,
      fetch: async (input, init) => {
        const url = String(input);
        if (!url.startsWith("https://api.github.com/")) throw new Error(`unexpected fetch ${url}`);
        const path = url.replace("https://api.github.com", "");
        github.push({ path, auth: new Headers(init?.headers).get("authorization") });
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
        if (path === "/repos/acme/site/issues/42")
          return json({
            title: "Checkout double-charges",
            body: "Paying twice on retry.",
            state: "open",
            comments: 1,
          });
        if (path.startsWith("/repos/acme/site/issues/42/comments"))
          return json([{ user: { login: "maya" }, body: "Seen on mobile only." }]);
        return json({ message: "Not Found" }, 404);
      },
    });
    c = new Client(h);
    await c.signIn("inputs@example.com");
    await c.request("POST", "/v1/workspaces", { name: "Inputs" });
    const openai = (
      await c.request("POST", "/v1/connectors", { registryKey: "openai-api", apiKey: OPENAI_KEY })
    ).json().connector;
    const price = { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null };
    agentId = (
      await c.request("POST", "/v1/agents", {
        connectorId: openai.id,
        name: "writer",
        model: "gpt-w",
        priceOverride: price,
      })
    ).json().agent.id;
    projectId = (
      await c.request("POST", "/v1/projects", {
        name: "site",
        repoUrl: "/srv/git/site.git",
        gitToken: GIT_TOKEN,
        githubRepo: "acme/site",
      })
    ).json().project.id;
  });
  afterAll(async () => {
    await h?.close();
  });

  it("refuses issue links it cannot read, and files that are too many or misnamed", async () => {
    const other = await c.request("POST", "/v1/missions", {
      goal: "x",
      issueUrl: "https://gitlab.com/acme/site/-/issues/1",
    });
    expect(other.json().error).toBe("unsupported_issue_link");
    const missing = await c.request("POST", "/v1/missions", {
      goal: "x",
      issueUrl: "https://github.com/acme/site/issues/7",
      projectId,
    });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error).toBe("issue_unreadable");
    const bad = await c.request("POST", "/v1/missions", {
      goal: "x",
      files: [{ name: "../etc/passwd", content: "x" }],
    });
    expect(bad.statusCode).toBe(400);
    const many = await c.request("POST", "/v1/missions", {
      goal: "x",
      files: Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, content: "x" })),
    });
    expect(many.statusCode).toBe(400);
  });

  it("reads the issue with the project's token and gives it, and the files, to every attempt", async () => {
    github.length = 0;
    const m = await c.request("POST", "/v1/missions", {
      goal: "Fix the double charge",
      projectId,
      plan: PLAN,
      routing: { strategy: "single", agentId },
      issueUrl: "https://github.com/acme/site/issues/42",
      files: [
        { name: "logs.txt", content: "POST /pay 200\nPOST /pay 200\n" },
        { name: "screen.png", content: PNG.toString("base64"), encoding: "base64", contentType: "image/png" },
      ],
    });
    expect(m.statusCode, m.body).toBe(201);
    expect(github.map((g) => g.auth)).toEqual([`Bearer ${GIT_TOKEN}`, `Bearer ${GIT_TOKEN}`]);
    const id = m.json().mission.id;
    expect(m.json().mission.inputs).toEqual({
      issue: { url: "https://github.com/acme/site/issues/42", title: "Checkout double-charges" },
      files: [
        { name: "logs.txt", size: 28, text: true },
        { name: "screen.png", size: PNG.length, text: false },
      ],
    });

    expect((await c.request("POST", `/v1/missions/${id}/plans/1/approve`)).statusCode).toBe(200);
    let dispatch: Record<string, unknown> | undefined;
    for (let i = 0; i < 100 && !dispatch; i++) {
      const [row] = await h.db.db
        .select({ d: schema.attempts.dispatch })
        .from(schema.attempts)
        .innerJoin(schema.tasks, eq(schema.tasks.id, schema.attempts.taskId))
        .where(eq(schema.tasks.missionId, id));
      dispatch = row?.d as Record<string, unknown> | undefined;
      if (!dispatch) await new Promise((r) => setTimeout(r, 100));
    }
    const input = dispatch?.input as { attachments: Array<{ kind: string; ref: string; text?: string }> };
    expect(input.attachments).toEqual([
      expect.objectContaining({ kind: "issue", ref: "https://github.com/acme/site/issues/42" }),
      expect.objectContaining({
        kind: "file",
        ref: "inputs/logs.txt",
        text: "POST /pay 200\nPOST /pay 200\n",
      }),
      expect.objectContaining({ kind: "file", ref: "inputs/screen.png" }),
    ]);
    expect(input.attachments[0]?.text).toContain("Paying twice on retry.");
    expect(input.attachments[0]?.text).toContain("maya: Seen on mobile only.");
    expect(input.attachments[2]?.text).toBeUndefined();
    const files = dispatch?.files as Array<{ path: string; content: string; encoding?: string }>;
    expect(files.find((f) => f.path === "inputs/issue.md")?.content).toContain(
      "# Checkout double-charges (open)",
    );
    expect(files.find((f) => f.path === "inputs/screen.png")).toEqual({
      path: "inputs/screen.png",
      content: PNG.toString("base64"),
      encoding: "base64",
    });
    expect(JSON.stringify(dispatch)).not.toContain(GIT_TOKEN);
  });
});
