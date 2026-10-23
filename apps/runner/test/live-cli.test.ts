// M2 acceptance against the real CLIs, with your own keys (never in PR CI):
//   LIVE_CLI_CLAUDE_CODE=1 ANTHROPIC_API_KEY=… LIVE_CLI_CLAUDE_CODE_MODEL=<id> pnpm --filter @brio/runner test:live
// Each enabled CLI gets the same task in the same fixture repo ("add a function + unit test"), in its real sandbox
// with its real egress allowlist. Then the tests are run again in a fresh sandbox from the attempt's branch.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS, type CliSpec, EMPTY_BRIEF, guardedFetch, redactingLogger } from "@brio/adapters";
import { chooseSandbox } from "@brio/core";
import { EventWriter, schema } from "@brio/db";
import { createTestDb, hasTestDatabase } from "@brio/db/testing";
import { Ledger } from "@brio/governance";
import { registry } from "@brio/registry";
import { LocalKeyProvider, Redactor, Vault } from "@brio/vault";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { DEFAULT_IMAGES, ensureImage } from "../src/images";
import { enqueueAttempt, startQueue } from "../src/queue";
import { Runner } from "../src/runner";
import { DockerSandbox } from "../src/sandbox/docker-sandbox";
import { Worktrees } from "../src/worktree";

const CLIS: Array<{ key: string; env: string; keyVar: string }> = [
  { key: "claude-code", env: "CLAUDE_CODE", keyVar: "ANTHROPIC_API_KEY" },
  { key: "codex", env: "CODEX", keyVar: "OPENAI_API_KEY" },
  { key: "cursor-agent", env: "CURSOR_AGENT", keyVar: "CURSOR_API_KEY" },
  { key: "antigravity", env: "ANTIGRAVITY", keyVar: "GEMINI_API_KEY" },
  { key: "opencode", env: "OPENCODE", keyVar: "OPENROUTER_API_KEY" },
  { key: "aider", env: "AIDER", keyVar: "ANTHROPIC_API_KEY" },
  { key: "goose", env: "GOOSE", keyVar: "ANTHROPIC_API_KEY" },
];

const g = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });

for (const cli of CLIS) {
  const enabled = process.env[`LIVE_CLI_${cli.env}`] === "1";
  describe.skipIf(!enabled || !hasTestDatabase)(`live CLI: ${cli.key}`, () => {
    it("adds a function and its unit test; the tests pass in a fresh sandbox", async () => {
      const key = process.env[cli.keyVar];
      const model = process.env[`LIVE_CLI_${cli.env}_MODEL`];
      if (!key || !model) throw new Error(`set ${cli.keyVar} and LIVE_CLI_${cli.env}_MODEL`);
      const adapter = ADAPTERS[cli.key] as (typeof ADAPTERS)[string] & { spec: CliSpec };
      await ensureImage(DEFAULT_IMAGES, "cli");
      await ensureImage(DEFAULT_IMAGES, "proxy");

      const db = await createTestDb();
      const dir = await mkdtemp(join(tmpdir(), `brio-live-${cli.key}-`));
      const redactor = new Redactor();
      const vault = new Vault(LocalKeyProvider.fromBase64(randomBytes(32).toString("base64")), redactor);
      const boss = await startQueue(db.url);
      try {
        const repo = join(dir, "fixture");
        await mkdir(repo);
        g(repo, "init", "-q", "-b", "main");
        await writeFile(join(repo, "package.json"), '{"type":"module","scripts":{"test":"node --test"}}\n');
        await writeFile(join(repo, "math.js"), "export const add = (a, b) => a + b;\n");
        g(repo, "add", ".");
        g(repo, "commit", "-q", "-m", "fixture");

        const [w] = await db.db
          .insert(schema.workspaces)
          .values({ name: "live", slug: `live-${randomBytes(3).toString("hex")}` })
          .returning();
        const [m] = await db.db
          .insert(schema.missions)
          .values({ workspaceId: w!.id, title: "live", goal: "add sub()", status: "running" })
          .returning();
        const secretId = (await vault.put(db.db, { workspaceId: w!.id, label: "live", value: key })).id;
        const preset = registry().preset(adapter.spec.vendorPreset)!;
        const [c] = await db.db
          .insert(schema.connectors)
          .values({
            workspaceId: w!.id,
            registryKey: adapter.spec.connector,
            displayName: cli.key,
            route: "cli",
            credentialRef: secretId,
            config: {},
          })
          .returning();
        const [a] = await db.db
          .insert(schema.agents)
          .values({ workspaceId: w!.id, connectorId: c!.id, name: cli.key, model })
          .returning();
        const contract = {
          objective: "Add sub(a, b) to math.js with a unit test",
          inputs: [],
          outputs: [{ kind: "diff" as const, description: "sub() and its test" }],
          acceptance: [{ kind: "tests" as const, command: "node --test", hard: true }],
          constraints: ["Use node:test and node:assert; no new dependencies."],
          sensitivity: "internal" as const,
        };
        const [t] = await db.db
          .insert(schema.tasks)
          .values({
            workspaceId: w!.id,
            missionId: m!.id,
            planVersion: 1,
            key: "add-sub",
            type: "code.feature",
            title: "Add sub()",
            status: "running",
            contract,
          })
          .returning();
        const sandbox = chooseSandbox({
          route: "cli",
          taskType: "code.feature",
          agentSetting: "standard",
          vendorHosts: adapter.spec.egressHosts,
          maxMinutes: 15,
        });
        const [attempt] = await db.db
          .insert(schema.attempts)
          .values({
            workspaceId: w!.id,
            taskId: t!.id,
            agentId: a!.id,
            role: "maker",
            status: "queued",
            dispatch: {
              version: 1,
              adapterKey: cli.key,
              route: "cli",
              missionId: m!.id,
              taskId: t!.id,
              taskKey: "add-sub",
              connectorId: c!.id,
              credentialRef: secretId,
              input: {
                taskTitle: "Add sub()",
                taskType: "code.feature",
                instructions:
                  "In math.js add and export sub(a, b) returning a - b. Add math.test.js using node:test and node:assert/strict that checks sub(5, 3) === 2. Run `node --test` and make sure it passes.",
                contract,
                handoffs: [],
                brief: EMPTY_BRIEF,
                attachments: [],
                limits: { maxCostUsd: 1, maxMinutes: 15, maxTurns: 30 },
                mcpServers: [],
              },
              agent: {
                agentId: a!.id,
                name: cli.key,
                model,
                rolePrompt: "",
                connector: {
                  registryKey: preset.connector,
                  presetKey: adapter.spec.vendorPreset,
                  preset,
                  baseUrl: preset.baseUrl!,
                },
                price: null,
              },
              sandbox,
              image: "cli",
              repo: { url: repo, branch: "main" },
            } as never,
          })
          .returning();

        const runner = new Runner({
          db: db.db,
          databaseUrl: db.url,
          boss,
          events: new EventWriter(redactor),
          ledger: new Ledger(redactor),
          vault,
          redactor,
          fetch: guardedFetch(globalThis.fetch, { allowPrivate: false, allowHttp: false }),
          log: redactingLogger((l, o, msg) => console.log(l, JSON.stringify(o), msg ?? ""), redactor),
          dir: join(dir, "runner"),
          images: DEFAULT_IMAGES,
        });
        await runner.start();
        await enqueueAttempt(boss, attempt!.id);
        let done: typeof schema.attempts.$inferSelect | undefined;
        for (let i = 0; i < 1200; i++) {
          [done] = await db.db.select().from(schema.attempts).where(eq(schema.attempts.id, attempt!.id));
          if (done && done.status !== "queued" && done.status !== "running") break;
          await new Promise((r) => setTimeout(r, 1000));
        }
        await runner.stop();
        expect(done?.status, done?.exitReason ?? "").toBe("succeeded");
        expect(done?.worktreeRef).toBeTruthy();

        // Re-run the acceptance check from the attempt's branch in a fresh, network-less sandbox.
        const wt = new Worktrees(join(dir, "verify"));
        const cache = join(dir, "runner", "repos");
        const branchRepo = execFileSync("ls", [cache])
          .toString()
          .split("\n")
          .find((f) => f.endsWith(".git"))!;
        const check = await wt.prepare({
          attemptId: randomBytes(16).toString("hex"),
          missionId: m!.id,
          taskKey: "verify",
          repo: { url: join(cache, branchRepo), branch: done!.worktreeRef! },
        });
        const box = await DockerSandbox.create({
          attemptId: `verify-${randomBytes(4).toString("hex")}`,
          runnerId: "live-verify",
          spec: { ...sandbox!, network: { mode: "none" } },
          image: DEFAULT_IMAGES.base,
          images: DEFAULT_IMAGES,
          worktree: check.path,
          scratchDir: join(dir, "scratch"),
        });
        try {
          const r = await box.exec("node --test", { timeoutMs: 120_000 });
          expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
        } finally {
          await box.destroy();
        }
      } finally {
        await boss.stop({ graceful: false });
        await db.drop();
        await rm(dir, { recursive: true, force: true });
      }
    }, 1_800_000);
  });
}
