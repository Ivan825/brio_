// M8 acceptance (CLI): `brio login` through the device flow against a real server, then `run`, `plan` (edit), `approve`,
// `board` following the mission over SSE to its end, `missions`, and `logout` ending the session. Needs Postgres.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approve, board, type Io, login, logout, missions, parseArgs, plan, run, whoami } from "@brio/cli";
import { hasTestDatabase } from "@brio/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";
import { type CallInfo, ScriptedVendors } from "./vendors";

const OPENAI_KEY = ["sk", "proj", "clicmds0123456789abcdefg"].join("-");
const doc = (key: string, title: string, dependsOn: string[] = []) => ({
  key,
  type: "write.summary",
  title,
  contract: {
    objective: title,
    inputs: [],
    outputs: [{ kind: "report", description: title }],
    acceptance: [{ kind: "diff_scope", hard: true }],
    constraints: [],
    sensitivity: "internal",
  },
  dependsOn,
  suggestedMode: "single",
});

describe.skipIf(!hasTestDatabase)("M8 acceptance: the brio CLI", () => {
  const vendors = new ScriptedVendors((call: CallInfo) => {
    if (call.body.includes("# Plan this mission")) {
      const g = {
        tasks: [doc("facts", "Gather the facts"), doc("tldr", "Write the summary", ["facts"])],
        assumptions: [],
        questions: [],
      };
      return { text: `\`\`\`json\n${JSON.stringify(g)}\n\`\`\`` };
    }
    return { text: "Done: three short paragraphs." };
  });
  let h: Harness;
  let person: Client;
  let dir: string;
  let base: string;
  const out: string[] = [];
  let io: Io;
  const said = () => out.join("");

  beforeAll(async () => {
    h = await startHarness({ fetch: vendors.fetch });
    base = await h.server.app.listen({ port: 0, host: "127.0.0.1" });
    person = new Client(h);
    await person.signIn("cli@example.com");
    await person.request("POST", "/v1/workspaces", { name: "Terminal" });
    const openai = (
      await person.request("POST", "/v1/connectors", { registryKey: "openai-api", apiKey: OPENAI_KEY })
    ).json().connector;
    const price = { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null };
    await person.request("POST", "/v1/agents", {
      connectorId: openai.id,
      name: "writer",
      model: "gpt-w",
      priceOverride: price,
    });
    dir = await mkdtemp(join(tmpdir(), "brio-cli-test-"));
    io = {
      out: (s) => void out.push(s),
      err: (s) => void out.push(s),
      configPath: join(dir, "config.json"),
      env: {},
      tty: false,
      color: false,
      width: () => 100,
    };
  });
  afterAll(async () => {
    await h?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("logs in with the device flow once the person approves the code", async () => {
    const pending = login(parseArgs(["login", "--url", base]), io);
    let code = "";
    for (let i = 0; i < 50 && !code; i++) {
      code = /confirm the code ([A-Z0-9-]+)/.exec(said())?.[1] ?? "";
      if (!code) await new Promise((r) => setTimeout(r, 50));
    }
    expect(said()).toContain(`${"http://localhost:3000"}/device?user_code=`);
    // As the /device page does: look the code up (claiming it for this person), then approve it.
    const userCode = code.replace("-", "");
    expect((await person.request("GET", `/api/auth/device?user_code=${userCode}`)).json().status).toBe(
      "pending",
    );
    const ok = await person.request("POST", "/api/auth/device/approve", { userCode });
    expect(ok.statusCode, ok.body).toBe(200);
    await pending;
    expect(said()).toContain("Signed in as cli@example.com · workspace Terminal");
    out.length = 0;
    await whoami(parseArgs(["whoami"]), io);
    expect(said()).toContain(`cli@example.com at ${base} · workspace Terminal`);
  }, 30_000);

  let missionId = "";
  it("runs a mission, edits and approves its plan, and follows it to the end", async () => {
    out.length = 0;
    await run(parseArgs(["run", "Summarise", "agent", "orchestration", "--budget", "3"]), io);
    missionId = /Mission ([0-9a-f]{8})/.exec(said())?.[1] ?? "";
    expect(missionId).toHaveLength(8);
    expect(said()).toContain(`${base}/missions/`);

    // The planner answers in a moment; then the plan shows, takes an edit, and is approved.
    let shown = "";
    for (let i = 0; i < 100 && !shown.includes("tldr"); i++) {
      out.length = 0;
      await plan(parseArgs(["plan", missionId]), io).catch(() => {});
      shown = said();
      if (!shown.includes("tldr")) await new Promise((r) => setTimeout(r, 150));
    }
    expect(shown).toContain("facts  write.summary  Gather the facts");
    expect(shown).toContain("(after facts)");
    out.length = 0;
    await plan(parseArgs(["plan", missionId, "--gate", "facts"]), io);
    expect(said()).toContain("plan v2 (proposed)");
    expect(said()).toContain("Gather the facts [approval gate]");
    await plan(parseArgs(["plan", missionId, "--ungate", "facts"]), io);

    out.length = 0;
    await approve(parseArgs(["approve"]), io);
    expect(said()).toContain(`plan v3 to approve · ${missionId}`);
    out.length = 0;
    await approve(parseArgs(["approve", missionId]), io);
    expect(said()).toContain("Approved plan v3 of Summarise agent orchestration");

    out.length = 0;
    await board(parseArgs(["board", missionId]), io);
    const text = said();
    expect(text).toMatch(/task\.done · facts/);
    expect(text).toMatch(/mission\.done/);
    expect(text).toMatch(/tldr\s+done\s+writer/);
    expect(text).toContain("Mission done.");

    out.length = 0;
    await missions(parseArgs(["missions"]), io);
    expect(said()).toMatch(new RegExp(`${missionId}\\s+done\\s+Summarise agent orchestration`));
  }, 120_000);

  it("logs out: the session ends on the server too", async () => {
    const { session } = JSON.parse(await (await import("node:fs/promises")).readFile(io.configPath, "utf8"));
    await logout(parseArgs(["logout"]), io);
    const res = await fetch(`${base}/v1/workspaces`, { headers: { authorization: `Bearer ${session}` } });
    expect(res.status).toBe(401);
    await expect(whoami(parseArgs(["whoami"]), io)).rejects.toThrow(/brio login/);
  });
});
