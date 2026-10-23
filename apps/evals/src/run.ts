// The eval runner (BUILD_PLAN M5): every golden mission under every routing strategy — each strategy in its own
// workspace, so the learned router learns only from its own run — then each result scored by the hidden scorer in a
// sandbox. The output is an EvalRun: per-mission results, per-strategy summaries, and the PRD verdict.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "@brio/adapters";
import { evalVerdict, summarise } from "@brio/core";
import { schema } from "@brio/db";
import { CHECK_SANDBOX, DockerSandbox, ensureImage, MergeConflictError, Worktrees } from "@brio/runner";
import type { EvalMissionResult, EvalRun } from "@brio/schema";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { type LoadedEvalMission, loadEvalMission } from "./golden";
import { type Exec, type ScoreResult, scoreAnswer, scoreCode } from "./score";
import { Client, type Stack, startStack } from "./stack";

const { artifacts, attempts, blobs, integrations, missions, tasks } = schema;

/** An agent the run sets up in each strategy's workspace. */
export interface EvalAgent {
  name: string;
  /** Registry connector id (openai-api, claude-api, groq-cerebras…). */
  connector: string;
  model: string;
  apiKey: string;
  apiStyle?: "chat" | "responses";
  baseUrl?: string;
  price?: { inputPerM: number; outputPerM: number };
}

export interface RunOptions {
  mode: "offline" | "live";
  missions: string[];
  /** learned, static, and single:<agent name>. */
  strategies: string[];
  agents: EvalAgent[];
  fetch?: FetchLike;
  /** Per mission. */
  timeoutMs: number;
  /** Passes over the missions in the same workspace (the learned router keeps its history); the last one is scored. */
  epochs?: number;
  /**
   * Rate each mission's results as its user would, thumbs up or down by the hidden checks (POST /v1/attempts/:id/rating).
   * The verifier only sees the contract's checks; a person's rating is how the router learns what they miss.
   */
  feedback?: boolean;
  /** Called before each mission (the simulation follows along). */
  onMission?: (strategy: string, mission: LoadedEvalMission) => void;
  log?: (line: string) => void;
  notes?: string;
}

const routingOf = (strategy: string, agentIds: Map<string, string>) => {
  if (strategy === "learned" || strategy === "static") return { strategy };
  const name = strategy.slice("single:".length);
  const agentId = agentIds.get(name);
  if (!agentId) throw new Error(`no agent ${name} for strategy ${strategy}`);
  return { strategy: "single", agentId };
};

function fixtureRepo(m: LoadedEvalMission): string | null {
  if (!m.repoDir) return null;
  const dir = mkdtempSync(join(tmpdir(), `brio-eval-${m.key}-`));
  cpSync(m.repoDir, dir, { recursive: true });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "evals",
    GIT_AUTHOR_EMAIL: "evals@brio.invalid",
    GIT_COMMITTER_NAME: "evals",
    GIT_COMMITTER_EMAIL: "evals@brio.invalid",
  };
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "-A"],
    ["commit", "-q", "-m", "fixture"],
  ])
    execFileSync("git", args, { cwd: dir, env });
  return dir;
}

export async function runEvals(o: RunOptions): Promise<EvalRun> {
  const log = o.log ?? (() => {});
  const startedAt = new Date().toISOString();
  const results: EvalMissionResult[] = [];
  const epochs = Math.max(1, o.epochs ?? 1);
  const loaded = o.missions.map(loadEvalMission);
  const stack = await startStack({ offline: o.mode === "offline", ...(o.fetch ? { fetch: o.fetch } : {}) });
  const repos: string[] = [];
  try {
    for (const strategy of o.strategies) {
      const c = new Client(stack.server);
      await c.signIn(`${strategy.replace(/[^a-z0-9]/gi, "-")}@evals.brio.invalid`);
      await c.request("POST", "/v1/workspaces", { name: `Evals · ${strategy}` });
      const agentIds = new Map<string, string>();
      const connectors = new Map<string, string>();
      for (const a of o.agents) {
        const key = `${a.connector}|${a.apiKey}|${a.apiStyle ?? ""}|${a.baseUrl ?? ""}`;
        let connectorId = connectors.get(key);
        if (!connectorId) {
          const made = await c.request("POST", "/v1/connectors", {
            registryKey: a.connector,
            apiKey: a.apiKey,
            ...(a.apiStyle ? { apiStyle: a.apiStyle } : {}),
            ...(a.baseUrl ? { baseUrl: a.baseUrl } : {}),
          });
          connectorId = (made.connector as { id: string }).id;
          connectors.set(key, connectorId);
        }
        const agent = await c.request("POST", "/v1/agents", {
          connectorId,
          name: a.name,
          model: a.model,
          limits: { maxCostUsd: 2, maxMinutes: 20 },
          ...(a.price ? { priceOverride: { ...a.price, cachedInputPerM: null, cacheWritePerM: null } } : {}),
        });
        agentIds.set(a.name, (agent.agent as { id: string }).id);
      }
      for (let epoch = 1; epoch <= epochs; epoch++)
        for (const m of loaded) {
          o.onMission?.(strategy, m);
          const repo = fixtureRepo(m);
          if (repo) repos.push(repo);
          const result = await runOne(
            stack,
            c,
            m,
            strategy,
            routingOf(strategy, agentIds),
            repo,
            o.timeoutMs,
            o.feedback ?? false,
          );
          results.push(epochs > 1 ? { ...result, epoch } : result);
          log(
            `${strategy.padEnd(14)} ${epochs > 1 ? `e${epoch} ` : ""}${m.key.padEnd(18)} ${result.passed ? "pass" : "FAIL"}  ${result.status.padEnd(7)} $${result.costUsd.toFixed(4)}  ${result.reason ?? ""}`,
          );
        }
    }
  } finally {
    await stack.close();
    for (const r of repos) rmSync(r, { recursive: true, force: true });
  }
  // With several passes, the last one is what the router has learned to do.
  const scored = epochs > 1 ? results.filter((r) => r.epoch === epochs) : results;
  const summaries = summarise(scored);
  return {
    mode: o.mode,
    startedAt,
    finishedAt: new Date().toISOString(),
    missions: o.missions,
    epochs,
    ...(o.feedback ? { feedback: true } : {}),
    summaries,
    results,
    verdict: evalVerdict(summaries),
    ...(o.notes ? { notes: o.notes } : {}),
  };
}

async function runOne(
  stack: Stack,
  c: Client,
  m: LoadedEvalMission,
  strategy: string,
  routing: Record<string, unknown>,
  repo: string | null,
  timeoutMs: number,
  feedback: boolean,
): Promise<EvalMissionResult> {
  let projectId: string | undefined;
  if (repo)
    projectId = (
      (await c.request("POST", "/v1/projects", { name: m.key, repoUrl: repo, defaultBranch: "main" }))
        .project as { id: string }
    ).id;
  const created = await c.request("POST", "/v1/missions", {
    goal: m.goal,
    title: m.title,
    plan: m.plan,
    routing,
    priority: "balanced",
    ...(projectId ? { projectId } : {}),
  });
  const id = (created.mission as { id: string }).id;
  const until = Date.now() + timeoutMs;
  let status = "running";
  for (;;) {
    const [row] = await stack.db.db.select().from(missions).where(eq(missions.id, id));
    status = row?.status ?? "missing";
    if (status === "done" || status === "failed" || status === "cancelled") break;
    if (Date.now() > until) {
      status = "timeout";
      await c.request("POST", `/v1/missions/${id}/cancel`).catch(() => {});
      break;
    }
    // Plans (the supplied one, and any revised plan) are approved as a person would.
    if (status === "awaiting_approval") {
      const plans = (await c.request("GET", `/v1/missions/${id}/plans`)).plans as {
        version: number;
        status: string;
      }[];
      const proposed = plans.filter((p) => p.status === "proposed").at(-1);
      if (proposed)
        await c.request("POST", `/v1/missions/${id}/plans/${proposed.version}/approve`).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  const [row] = await stack.db.db.select().from(missions).where(eq(missions.id, id));
  const tried = await stack.db.db
    .select({ costUsd: attempts.costUsd })
    .from(attempts)
    .innerJoin(tasks, eq(tasks.id, attempts.taskId))
    .where(eq(tasks.missionId, id));
  const score = await scoreMission(stack, m, id, repo).catch((err: Error) => ({
    passed: false,
    reason: `could not score: ${err.message}`,
  }));
  if (feedback) {
    const ts = await stack.db.db.select().from(tasks).where(eq(tasks.missionId, id));
    for (const t of ts) {
      const a = await resultAttempt(stack, t);
      if (a?.status === "succeeded")
        await c
          .request("POST", `/v1/attempts/${a.id}/rating`, { rating: score.passed ? 1 : -1 })
          .catch(() => {});
    }
  }
  return {
    mission: m.key,
    strategy,
    passed: score.passed,
    status,
    costUsd: Math.round(tried.reduce((s, a) => s + (a.costUsd ?? 0), 0) * 1e6) / 1e6,
    minutes: row ? Math.round((Date.now() - row.createdAt.getTime()) / 600) / 100 : 0,
    attempts: tried.length,
    reason: score.reason.slice(0, 2000),
  };
}

/** The task's standing result: the attempt a mode chose, else its latest made attempt (succeeded first). */
async function resultAttempt(stack: Stack, t: typeof tasks.$inferSelect) {
  const picked = (t.modeParams as { result?: { attemptId: string } }).result?.attemptId;
  const rows = await stack.db.db
    .select()
    .from(attempts)
    .where(eq(attempts.taskId, t.id))
    .orderBy(desc(attempts.createdAt));
  const made = rows.filter((a) => {
    const purpose = (a.dispatch as { mode?: { purpose?: string } } | null)?.mode?.purpose ?? "make";
    return ["make", "revise", "merge"].includes(purpose);
  });
  return rows.find((a) => a.id === picked) ?? made.find((a) => a.status === "succeeded") ?? made[0] ?? null;
}

async function scoreMission(
  stack: Stack,
  m: LoadedEvalMission,
  missionId: string,
  repo: string | null,
): Promise<ScoreResult> {
  const planned = await stack.db.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.missionId, missionId), gt(tasks.planVersion, 0)))
    .orderBy(desc(tasks.planVersion), asc(tasks.createdAt));
  const latestVersion = planned[0]?.planVersion;
  const current = planned.filter((t) => t.planVersion === latestVersion);

  if (m.scorer.kind === "text" || m.scorer.kind === "json") {
    const key = m.scorer.task;
    const t = current.find((x) => x.key === key);
    const a = t ? await resultAttempt(stack, t) : null;
    if (!a) return { passed: false, reason: `no result for ${key}` };
    const [report] = await stack.db.db
      .select({ bytes: blobs.bytes })
      .from(artifacts)
      .innerJoin(blobs, and(eq(blobs.workspaceId, artifacts.workspaceId), eq(blobs.sha256, artifacts.sha256)))
      .where(and(eq(artifacts.attemptId, a.id), eq(artifacts.kind, "report")));
    const answer = report?.bytes.toString("utf8") ?? "";
    const r = scoreAnswer(m.scorer, answer);
    // A failed answer is quoted (briefly) so the run says what was produced.
    return r.passed ? r : { ...r, reason: `${r.reason} — answer: ${JSON.stringify(answer.slice(0, 300))}` };
  }

  // Code: the integration branch when one passed; otherwise every task's latest result merged.
  const worktrees = new Worktrees(stack.runnerDir);
  const cache = await worktrees.cache(repo ? { repo: { url: repo, branch: "main" } } : { missionId });
  const [integration] = await stack.db.db
    .select()
    .from(integrations)
    .where(and(eq(integrations.missionId, missionId), eq(integrations.status, "passed")))
    .orderBy(desc(integrations.createdAt))
    .limit(1);
  let bases: string[] = [];
  if (integration?.branch) bases = [integration.branch];
  else {
    const refs: string[] = [];
    for (const t of current) {
      const a = await resultAttempt(stack, t);
      if (a?.worktreeRef) refs.push(a.worktreeRef);
    }
    bases = refs;
  }
  if (!bases.length) return { passed: false, reason: "no code was produced" };
  let prepared: Awaited<ReturnType<Worktrees["prepare"]>>;
  try {
    prepared = await worktrees.prepare({
      attemptId: `score-${missionId}`,
      missionId,
      taskKey: "score",
      bases,
      cacheOverride: cache,
    });
  } catch (err) {
    if (err instanceof MergeConflictError)
      return { passed: false, reason: `the results conflict: ${err.message}` };
    throw err;
  }
  // Agent output only ever runs in a sandbox: no network, the usual limits.
  let sandbox: DockerSandbox | null = null;
  try {
    sandbox = await DockerSandbox.create({
      attemptId: `score-${missionId}`,
      runnerId: "evals",
      spec: { ...CHECK_SANDBOX, network: { mode: "none" } },
      image: await ensureImage(stack.images, "base"),
      images: stack.images,
      worktree: prepared.path,
      scratchDir: join(stack.runnerDir, "scratch"),
    });
    const box = sandbox;
    const exec: Exec = async (_cwd, command) => {
      const r = await box.exec(command, { timeoutMs: 5 * 60_000 });
      return { exitCode: r.exitCode, output: `${r.stdout}\n${r.stderr}` };
    };
    return await scoreCode(m, prepared.path, exec);
  } finally {
    await sandbox?.destroy().catch(() => {});
    await worktrees.remove(prepared).catch(() => {});
  }
}
