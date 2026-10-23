import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Worktrees } from "../src/worktree";

let root: string;
let upstream: string;
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  })
    .toString()
    .trim();

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "brio-wt-"));
  upstream = join(root, "upstream");
  await mkdir(upstream);
  sh(upstream, "init", "-q", "-b", "main");
  await writeFile(join(upstream, "math.js"), "export const add = (a, b) => a + b;\n");
  sh(upstream, "add", ".");
  sh(upstream, "commit", "-q", "-m", "init");
});
afterAll(async () => rm(root, { recursive: true, force: true }));

describe("worktrees", () => {
  it("prepares a branch per attempt and collects the agent's changes from a trusted repo", async () => {
    const wt = new Worktrees(join(root, "runner"));
    const w = await wt.prepare({
      attemptId: "0192b3c4-5d6e-7f80-9a1b-000000000001",
      missionId: "0192b3c4-5d6e-7f80-9a1b-0000000000aa",
      taskKey: "add-sub",
      repo: { url: upstream },
    });
    expect(w.branch).toBe("brio/0192b3c4/add-sub/0192b3c4");
    expect(await readFile(join(w.path, "math.js"), "utf8")).toContain("add");

    // The agent edits, adds, deletes, makes a symlink to a host file, and booby-traps its own .git.
    await writeFile(
      join(w.path, "math.js"),
      "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n",
    );
    await writeFile(join(w.path, "math.test.js"), "test\n");
    execFileSync("ln", ["-s", "/etc/hosts", join(w.path, "leak")]);
    const marker = join(root, "pwned");
    const hook = join(w.path, ".git", "hooks", "pre-commit");
    await writeFile(hook, `#!/bin/sh\ntouch ${marker}\n`);
    await chmod(hook, 0o755);
    sh(w.path, "config", "core.fsmonitor", `touch ${marker}; true`);

    const r = await wt.collect(w, "0192b3c4-5d6e-7f80-9a1b-000000000001", "attempt 1");
    expect(existsSync(marker)).toBe(false);
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(r.diff.toString()).toContain("+export const sub");
    const byPath = Object.fromEntries(r.files.map((f) => [f.path, f]));
    expect(byPath["math.js"]?.status).toBe("modified");
    expect(byPath["math.test.js"]).toMatchObject({
      status: "added",
      sha256: createHash("sha256").update("test\n").digest("hex"),
    });
    // The symlink is recorded as a link to its target path, never followed on the host.
    expect(byPath.leak?.content?.toString()).toBe("/etc/hosts");
    expect(Object.keys(byPath).some((p) => p.startsWith(".git"))).toBe(false);
    // The branch lives in the runner's cache, ready for merge.
    expect(sh(root, "--git-dir", w.cache, "rev-parse", `refs/heads/${w.branch}`)).toBe(r.commit);
    await wt.remove(w);
  });

  it("reports no changes as no commit", async () => {
    const wt = new Worktrees(join(root, "runner"));
    const w = await wt.prepare({
      attemptId: "0192b3c4-5d6e-7f80-9a1b-000000000002",
      missionId: "0192b3c4-5d6e-7f80-9a1b-0000000000aa",
      taskKey: "noop",
      repo: { url: upstream },
    });
    expect((await wt.collect(w, "a2", "noop")).commit).toBeNull();
  });

  it("gives project-less missions an empty repository, and refetches without losing attempt branches", async () => {
    const wt = new Worktrees(join(root, "runner"));
    const w = await wt.prepare({
      attemptId: "0192b3c4-5d6e-7f80-9a1b-000000000003",
      missionId: "0192b3c4-5d6e-7f80-9a1b-0000000000bb",
      taskKey: "scratch",
    });
    await writeFile(join(w.path, "README.md"), "hi\n");
    const r = await wt.collect(w, "a3", "first");
    expect(r.files.map((f) => f.path)).toEqual(["README.md"]);

    const again = await wt.prepare({
      attemptId: "0192b3c4-5d6e-7f80-9a1b-000000000004",
      missionId: "0192b3c4-5d6e-7f80-9a1b-0000000000aa",
      taskKey: "again",
      repo: { url: upstream },
    });
    expect(sh(root, "--git-dir", again.cache, "branch", "--list", "brio/*")).toContain(
      "brio/0192b3c4/add-sub/0192b3c4",
    );
  });
});

describe("worktree hand-over files", () => {
  it("keeps .brio/ (prompt, brief, handoffs) out of the result", async () => {
    const wt = new Worktrees(join(root, "runner"));
    const w = await wt.prepare({
      attemptId: "0192b3c4-5d6e-7f80-9a1b-000000000009",
      missionId: "0192b3c4-5d6e-7f80-9a1b-0000000000cc",
      taskKey: "brio-dir",
    });
    await mkdir(join(w.path, ".brio"), { recursive: true });
    await writeFile(join(w.path, ".brio", "prompt.md"), "the task\n");
    await writeFile(join(w.path, "out.txt"), "result\n");
    const r = await wt.collect(w, "a9", "with brio dir");
    expect(r.files.map((f) => f.path)).toEqual(["out.txt"]);
  });
});
