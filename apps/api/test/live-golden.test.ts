// The M3 golden mission against real vendors, with your own keys (never in PR CI):
//   LIVE_GOLDEN=1 OPENAI_API_KEY=… ANTHROPIC_API_KEY=… LIVE_GOLDEN_OPENAI_MODEL=<id> LIVE_GOLDEN_ANTHROPIC_MODEL=<id> \
//   pnpm --filter @brio/api test:live
// "Add OAuth login + tests to sample Next.js app": planned into ≥ 4 tasks including a contract task, approved as
// planned, run with two vendors, and finished with its checks passing. Needs Docker.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEventsSince, schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { loadGolden } from "@brio/evals";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Client, startHarness } from "./helpers";

const enabled = process.env.LIVE_GOLDEN === "1";

describe.skipIf(!enabled || !hasTestDatabase)("live golden mission: oauth-login", () => {
  it(
    "plans, runs on two vendors and finishes with passing checks",
    async () => {
      const golden = loadGolden("oauth-login");
      const repo = mkdtempSync(join(tmpdir(), "brio-golden-"));
      cpSync(golden.repoDir, repo, { recursive: true });
      const git = (...a: string[]) =>
        execFileSync("git", a, {
          cwd: repo,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "golden",
            GIT_AUTHOR_EMAIL: "g@g",
            GIT_COMMITTER_NAME: "golden",
            GIT_COMMITTER_EMAIL: "g@g",
          },
        });
      git("init", "-q", "-b", "main");
      git("add", ".");
      git("commit", "-q", "-m", "fixture");

      const h = await startHarness({});
      try {
        const c = new Client(h);
        await c.signIn("golden@example.com");
        await c.request("POST", "/v1/workspaces", { name: "Golden" });
        const openai = (
          await c.request("POST", "/v1/connectors", {
            registryKey: "openai-api",
            apiKey: process.env.OPENAI_API_KEY,
          })
        ).json().connector;
        const anthropic = (
          await c.request("POST", "/v1/connectors", {
            registryKey: "claude-api",
            apiKey: process.env.ANTHROPIC_API_KEY,
          })
        ).json().connector;
        expect(openai.health.ok && anthropic.health.ok).toBe(true);
        const agent = async (name: string, connectorId: string, model: string) =>
          (
            await c.request("POST", "/v1/agents", {
              connectorId,
              name,
              model,
              limits: { maxCostUsd: 2, maxMinutes: 20 },
            })
          ).json().agent.id as string;
        const planner = await agent("planner", openai.id, process.env.LIVE_GOLDEN_OPENAI_MODEL ?? "");
        await agent("anthropic-coder", anthropic.id, process.env.LIVE_GOLDEN_ANTHROPIC_MODEL ?? "");
        const project = (
          await c.request("POST", "/v1/projects", { name: "sample", repoUrl: repo, defaultBranch: "main" })
        ).json().project;

        const missionId = (
          await c.request("POST", "/v1/missions", {
            goal: golden.goal,
            projectId: project.id,
            plannerAgentId: planner,
            budget: { usd: 10 },
          })
        ).json().mission.id;
        const wait = async (pred: () => Promise<boolean>, ms: number) => {
          const until = Date.now() + ms;
          while (!(await pred())) {
            if (Date.now() > until) throw new Error("timed out");
            await new Promise((r) => setTimeout(r, 2000));
          }
        };
        await wait(
          async () => (await c.request("GET", `/v1/missions/${missionId}/plans`)).json().plans.length > 0,
          10 * 60_000,
        );
        const plan = (await c.request("GET", `/v1/missions/${missionId}/plans`)).json().plans.at(-1);
        expect(plan.graph.tasks.length).toBeGreaterThanOrEqual(golden.expect.minTasks);
        expect(plan.graph.tasks.some((t: { type: string }) => t.type.startsWith("design."))).toBe(
          golden.expect.contractTask,
        );
        const approved = await c.request("POST", `/v1/missions/${missionId}/plans/${plan.version}/approve`);
        expect(approved.statusCode, approved.body).toBe(200);

        await wait(async () => {
          const [m] = await h.db.db.select().from(schema.missions).where(eq(schema.missions.id, missionId));
          return m?.status === "done" || m?.status === "failed";
        }, 60 * 60_000);
        const [m] = await h.db.db.select().from(schema.missions).where(eq(schema.missions.id, missionId));
        expect(m?.status, m?.blockedReason ?? "").toBe("done");
        const events = await readEventsSince(h.db.db, missionId, 0, 100_000);
        const vendors = new Set(
          events
            .filter((e) => e.type === "attempt.queued")
            .map((e) => (e.payload as { connector: { preset: string } }).connector.preset),
        );
        expect(vendors.size).toBeGreaterThanOrEqual(golden.expect.vendors);
        expect(events.some((e) => e.type === "handoff.created")).toBe(true);
      } finally {
        await h.close();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    2 * 3600_000,
  );
});
