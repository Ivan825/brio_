// M9 (D-14): the global scoreboard. Workspaces opt in to add their outcomes, anonymised; others opt in to start agents
// they have not seen from those numbers. Nothing global is used or shown until enough outcomes from enough workspaces
// stand behind it, and nothing says whose they were. Needs Postgres.
import { schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Scoreboard } from "../src/orchestrator/scoreboard";
import { Client, type Harness, startHarness } from "./helpers";
import { ScriptedVendors } from "./vendors";

const OPENAI_KEY = ["sk", "proj", "globalscores0123456789abc"].join("-");
const KEY = "openai-api/gpt-coder";
const TYPE = "code.feature";

interface Ws {
  client: Client;
  id: string;
  agentId: string;
  taskId: string;
}

describe.skipIf(!hasTestDatabase)("M9: the global scoreboard (D-14)", () => {
  let h: Harness;
  let board: Scoreboard;
  const ws: Ws[] = [];

  const call = (w: Ws, method: "GET" | "PUT", url: string, body?: unknown) =>
    w.client.request(method, url, body, { "x-brio-workspace": w.id });

  beforeAll(async () => {
    h = await startHarness({ runner: false, fetch: new ScriptedVendors(() => ({ text: "ok" })).fetch });
    board = new Scoreboard(h.server.ctx);
    for (const name of ["a", "b", "c", "d"]) {
      const client = new Client(h);
      await client.signIn(`${name}-global@example.com`);
      const id = (await client.request("POST", "/v1/workspaces", { name: `Global ${name}` })).json().workspace
        .id;
      const connector = (
        await client.request("POST", "/v1/connectors", { registryKey: "openai-api", apiKey: OPENAI_KEY })
      ).json().connector;
      const agentId = (
        await client.request("POST", "/v1/agents", {
          connectorId: connector.id,
          name: "coder",
          model: "gpt-coder",
          priceOverride: { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null },
        })
      ).json().agent.id;
      const [m] = await h.db.db
        .insert(schema.missions)
        .values({ workspaceId: id, title: "Scores", goal: "Scores", status: "running" })
        .returning();
      const [t] = await h.db.db
        .insert(schema.tasks)
        .values({
          workspaceId: id,
          missionId: m!.id,
          planVersion: 1,
          key: "t",
          type: TYPE,
          title: "T",
          contract: {
            objective: "T",
            inputs: [],
            outputs: [{ kind: "diff", description: "t" }],
            acceptance: [{ kind: "diff_scope", hard: true }],
            constraints: [],
            sensitivity: "internal",
          },
        })
        .returning();
      ws.push({ client, id, agentId, taskId: t!.id });
    }
  });
  afterAll(async () => {
    await h?.close();
  });

  /** Scores `n` finished attempts of the workspace's agent with this outcome. */
  async function outcomes(w: Ws, n: number, outcome: "pass" | "fail") {
    for (let i = 0; i < n; i++) {
      const [a] = await h.db.db
        .insert(schema.attempts)
        .values({
          workspaceId: w.id,
          taskId: w.taskId,
          agentId: w.agentId,
          role: "maker",
          status: outcome === "pass" ? "succeeded" : "failed",
          costUsd: 0.01,
          dispatch: { route: "api", agent: { model: "gpt-coder", connector: { presetKey: "openai-api" } } },
        })
        .returning();
      expect(await board.outcome(a!.id, outcome, TYPE)).toBe(true);
    }
  }

  const globalRows = () => h.db.db.select().from(schema.scores).where(eq(schema.scores.scope, "global"));

  it("shares nothing by default", async () => {
    expect((await call(ws[0]!, "GET", "/v1/scoreboard/sharing")).json().sharing).toEqual({
      share: false,
      useGlobal: false,
    });
    await outcomes(ws[0]!, 5, "pass");
    expect(await globalRows()).toEqual([]);
  });

  it("lets only owners and admins change it, and records the change", async () => {
    const res = await call(ws[0]!, "PUT", "/v1/scoreboard/sharing", { share: true, useGlobal: false });
    expect(res.statusCode, res.body).toBe(200);
    const [entry] = await h.db.db
      .select()
      .from(schema.ledger)
      .where(eq(schema.ledger.workspaceId, ws[0]!.id))
      .then((rows) => rows.filter((r) => r.kind === "policy.change"));
    expect(entry?.payload).toMatchObject({ scoreSharing: { share: true, useGlobal: false } });
    for (const w of ws.slice(1, 3))
      expect(
        (await call(w, "PUT", "/v1/scoreboard/sharing", { share: true, useGlobal: false })).statusCode,
      ).toBe(200);
    expect(
      (await call(ws[3]!, "PUT", "/v1/scoreboard/sharing", { share: false, useGlobal: true })).statusCode,
    ).toBe(200);
  });

  it("adds sharing workspaces' outcomes without saying whose", async () => {
    await outcomes(ws[0]!, 12, "pass");
    await outcomes(ws[1]!, 12, "pass");
    const rows = await globalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: null, agentKey: KEY, taskType: TYPE, n: 24 });
    const contributors = await h.db.db.select().from(schema.scoreContributors);
    expect(contributors).toHaveLength(2);
    const stored = JSON.stringify([rows, contributors]);
    for (const w of ws) expect(stored).not.toContain(w.id);
  });

  it("uses and shows nothing until enough workspaces stand behind it", async () => {
    // 24 outcomes, but from two workspaces: below the minimum of three.
    expect((await call(ws[3]!, "GET", "/v1/scoreboard/global")).json().rows).toEqual([]);
    const before = (await board.get(ws[3]!.id, [KEY], TYPE)).get(KEY)!;
    expect(before.n).toBe(0);
    expect(before.alpha).toBe(1);
  });

  it("starts an unseen agent from the global numbers once three workspaces share", async () => {
    await outcomes(ws[2]!, 6, "fail");
    const global = (await call(ws[3]!, "GET", "/v1/scoreboard/global")).json();
    expect(global.minimum).toEqual({ outcomes: 20, workspaces: 3 });
    expect(global.rows).toEqual([expect.objectContaining({ agentKey: KEY, taskType: TYPE, n: 30 })]);
    expect(JSON.stringify(global)).not.toMatch(/workspace(Id)?":"/);
    // The workspace that uses global numbers starts from a prior leaning to pass (24 of 30), not from scratch.
    const prior = (await board.get(ws[3]!.id, [KEY], TYPE)).get(KEY)!;
    expect(prior.alpha).toBeGreaterThan(prior.beta);
    // One that did not opt in still starts fresh.
    await call(ws[3]!, "PUT", "/v1/scoreboard/sharing", { share: false, useGlobal: false });
    const fresh = (await board.get(ws[3]!.id, [KEY], TYPE)).get(KEY)!;
    expect(fresh.alpha).toBe(fresh.beta);
  });

  it("keeps a workspace's own numbers first", async () => {
    await call(ws[3]!, "PUT", "/v1/scoreboard/sharing", { share: false, useGlobal: true });
    await outcomes(ws[3]!, 3, "fail");
    const own = (await board.get(ws[3]!.id, [KEY], TYPE)).get(KEY)!;
    expect(own.n).toBe(3);
    expect(own.beta).toBeGreaterThan(own.alpha);
    // It did not share, so the global row is unchanged.
    expect((await globalRows())[0]?.n).toBe(30);
  });
});
