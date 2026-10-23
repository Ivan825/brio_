// Delivery helpers (BUILD_PLAN M8): which repositories get a pull request, and a repository token that travels in the
// environment only — never on the command line, in the cache's config or in a remote URL.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { githubRepoOf } from "../src/deliver";
import { gitAuthEnv, Worktrees } from "../src/worktree";

const run = promisify(execFile);
const TOKEN = ["ghp", "deliver0123456789abcdefghijklmnopqrs"].join("_");

describe("delivery", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("knows a GitHub repository by its URL or the project's setting", () => {
    expect(githubRepoOf("https://github.com/acme/site.git", {})).toBe("acme/site");
    expect(githubRepoOf("https://github.com/acme/site", {})).toBe("acme/site");
    expect(githubRepoOf("https://gitlab.com/acme/site.git", {})).toBeNull();
    expect(githubRepoOf("/srv/git/site.git", { github: { repo: "acme/site" } })).toBe("acme/site");
    expect(githubRepoOf("/srv/git/site.git", { github: { repo: "not a repo" } })).toBeNull();
  });

  it("sends the token as a header from the environment and stores it nowhere", async () => {
    const env = gitAuthEnv(TOKEN);
    expect(env.GIT_CONFIG_KEY_0).toBe("http.extraHeader");
    expect(
      Buffer.from(env.GIT_CONFIG_VALUE_0!.replace("Authorization: Basic ", ""), "base64").toString(),
    ).toBe(`x-access-token:${TOKEN}`);
    expect(gitAuthEnv(null)).toEqual({});

    const root = await mkdtemp(join(tmpdir(), "brio-deliver-"));
    dirs.push(root);
    const remote = join(root, "remote.git");
    await run("git", ["init", "--bare", "-q", "-b", "main", remote]);
    const seed = join(root, "seed");
    await run("git", ["clone", "-q", remote, seed]);
    await run("git", [
      "-C",
      seed,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "first",
    ]);
    await run("git", ["-C", seed, "push", "-q", "origin", "HEAD:main"]);

    const w = new Worktrees(join(root, "runner"));
    const cache = await w.cache({ repo: { url: remote } }, { token: TOKEN });
    const head = (await w.git(["--git-dir", cache, "rev-parse", "refs/heads/main"])).stdout.toString().trim();
    await w.git(["--git-dir", cache, "push", "-q", "--", remote, `${head}:refs/heads/brio/delivered`], {
      env: gitAuthEnv(TOKEN),
    });
    const { stdout } = await run("git", ["--git-dir", remote, "rev-parse", "refs/heads/brio/delivered"]);
    expect(stdout.trim()).toBe(head);
    expect(await readFile(join(cache, "config"), "utf8")).not.toContain(TOKEN);
    expect(await readFile(join(cache, "config"), "utf8")).not.toContain("x-access-token");
  });
});
