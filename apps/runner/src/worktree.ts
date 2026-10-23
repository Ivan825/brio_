// Git worktree per attempt (ARCHITECTURE §4.3). The agent gets a plain clone it fully controls inside its sandbox. The
// runner never trusts that clone's .git: it computes the result with its own cached repository and a private index
// over the worktree's files, with hooks, fsmonitor and global/system config disabled. A hostile agent can write
// whatever it likes into .git/config or .git/hooks; none of it runs on the host.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

export interface GitResult {
  stdout: Buffer;
  stderr: string;
}

export class GitError extends Error {
  override name = "GitError";
}

const SAFE_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.symlinks=true",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.file.allow=always",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "advice.detachedHead=false",
];

export interface RepoSource {
  /** A git URL (https) or a local path. */
  url: string;
  /** Branch to start from; the remote default when absent. */
  branch?: string | null;
}

export interface PreparedWorktree {
  path: string;
  branch: string;
  base: string;
  cache: string;
}

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "type_changed";
  /** sha256 of the new content (absent for deletions). */
  sha256?: string;
  size?: number;
  /** The new content, when it is small enough to keep as an artifact. */
  content?: Buffer;
}

export interface CollectedResult {
  /** Null when the agent changed nothing. */
  commit: string | null;
  diff: Buffer;
  diffTruncated: boolean;
  files: ChangedFile[];
}

export const LIMITS = { diffBytes: 5 * 1024 * 1024, fileBytes: 1024 * 1024, files: 500 };

const STATUS: Record<string, ChangedFile["status"]> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  T: "type_changed",
};

export class Worktrees {
  constructor(private readonly root: string) {}

  private env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: this.root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Brio",
      GIT_AUTHOR_EMAIL: "agent@brio.invalid",
      GIT_COMMITTER_NAME: "Brio",
      GIT_COMMITTER_EMAIL: "agent@brio.invalid",
      ...extra,
    };
  }

  git(
    args: string[],
    opts: { cwd?: string; env?: Record<string, string>; input?: string } = {},
  ): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        "git",
        [...SAFE_CONFIG, ...args],
        {
          cwd: opts.cwd ?? this.root,
          env: this.env(opts.env),
          encoding: "buffer",
          maxBuffer: 64 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          if (err)
            reject(new GitError(`git ${args[0]} failed: ${stderr.toString("utf8").trim().slice(-500)}`));
          else resolve({ stdout, stderr: stderr.toString("utf8") });
        },
      );
      if (opts.input !== undefined) child.stdin?.end(opts.input);
    });
  }

  private async text(args: string[], opts: Parameters<Worktrees["git"]>[1] = {}) {
    return (await this.git(args, opts)).stdout.toString("utf8").trim();
  }

  /**
   * The runner's own copy of a repository: a mirror of a project repo, or an empty repo for project-less missions.
   * Creation is serialised per path (attempts of one mission start together), and a concurrent creator in another
   * process is tolerated.
   */
  async cache(key: { repo: RepoSource } | { missionId: string }): Promise<string> {
    const path =
      "missionId" in key
        ? join(this.root, "repos", `mission-${key.missionId}.git`)
        : join(
            this.root,
            "repos",
            `${createHash("sha256").update(key.repo.url).digest("hex").slice(0, 16)}.git`,
          );
    const prev = Worktrees.locks.get(path) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.ensureCache(key, path));
    Worktrees.locks.set(path, next);
    try {
      return await next;
    } finally {
      if (Worktrees.locks.get(path) === next) Worktrees.locks.delete(path);
    }
  }

  private static readonly locks = new Map<string, Promise<string>>();

  private async ensureCache(
    key: { repo: RepoSource } | { missionId: string },
    path: string,
  ): Promise<string> {
    await mkdir(join(this.root, "repos"), { recursive: true });
    if ("missionId" in key) {
      try {
        await this.text(["--git-dir", path, "rev-parse", "--verify", "refs/heads/main"]);
      } catch {
        await this.git(["init", "--bare", "-q", "-b", "main", path]).catch(async (e: Error) => {
          // Another runner process created it a moment ago.
          await this.text(["--git-dir", path, "rev-parse", "--git-dir"]).catch(() => {
            throw e;
          });
        });
        if (await this.text(["--git-dir", path, "rev-parse", "--verify", "refs/heads/main"]).catch(() => ""))
          return path;
        const tree = await this.text(["--git-dir", path, "hash-object", "-t", "tree", "-w", "--stdin"], {
          input: "",
        });
        const commit = await this.text([
          "--git-dir",
          path,
          "commit-tree",
          tree,
          "-m",
          "Empty workspace for this mission",
        ]);
        await this.git(["--git-dir", path, "update-ref", "refs/heads/main", commit]);
      }
      return path;
    }
    try {
      await this.text(["--git-dir", path, "rev-parse", "--git-dir"]);
      // No --prune: brio/* attempt branches live here too and must survive a fetch.
      await this.git(["--git-dir", path, "fetch", "-q", "origin", "+refs/heads/*:refs/heads/*"]);
    } catch {
      await rm(path, { recursive: true, force: true });
      await this.git(["clone", "-q", "--mirror", "--", key.repo.url, path]);
    }
    return path;
  }

  /** A fresh worktree for one attempt on branch brio/<mission>/<task>/<attempt>. */
  async prepare(i: {
    attemptId: string;
    missionId: string;
    taskKey: string;
    repo?: RepoSource | null;
    /** Branches in the cache to start from (upstream attempts); several are merged. */
    bases?: string[];
    /** Use an existing cache (check runs on a branch the cache already holds). */
    cacheOverride?: string;
  }): Promise<PreparedWorktree> {
    const cache =
      i.cacheOverride ?? (await this.cache(i.repo ? { repo: i.repo } : { missionId: i.missionId }));
    let base: string;
    if (i.bases?.length) base = await this.mergeBases(cache, i.bases);
    else {
      const ref = i.repo?.branch
        ? `refs/heads/${i.repo.branch}`
        : (await this.text(["--git-dir", cache, "symbolic-ref", "HEAD"]).catch(() => "refs/heads/main")) ||
          "refs/heads/main";
      base = await this.text(["--git-dir", cache, "rev-parse", "--verify", `${ref}^{commit}`]);
    }
    const branch = `brio/${i.missionId.slice(0, 8)}/${i.taskKey}/${i.attemptId.slice(0, 8)}`;
    const path = join(this.root, "worktrees", i.attemptId);
    await rm(path, { recursive: true, force: true });
    await mkdir(join(this.root, "worktrees"), { recursive: true });
    await this.git(["clone", "-q", "--no-hardlinks", "--no-checkout", "--", cache, path]);
    await this.git(["-C", path, "checkout", "-q", "-B", branch, base]);
    return { path, branch, base, cache };
  }

  /**
   * One commit holding all the given branches: the branch itself for one, else their merge, computed in the trusted
   * cache without a worktree. Throws on a conflict.
   */
  async mergeBases(cache: string, branches: string[]): Promise<string> {
    const heads = await Promise.all(
      branches.map((b) =>
        this.text(["--git-dir", cache, "rev-parse", "--verify", `refs/heads/${b}^{commit}`]),
      ),
    );
    let commit = heads[0] as string;
    for (let k = 1; k < heads.length; k++) {
      const other = heads[k] as string;
      const merged = await this.git([
        "--git-dir",
        cache,
        "merge-tree",
        "--write-tree",
        "--no-messages",
        commit,
        other,
      ]).catch((e: Error) => {
        throw new GitError(
          `the upstream changes conflict (${branches[0]} and ${branches[k]}); a merge task is needed: ${e.message}`,
        );
      });
      const tree = merged.stdout.toString("utf8").trim().split("\n")[0] as string;
      commit = await this.text([
        "--git-dir",
        cache,
        "commit-tree",
        tree,
        "-p",
        commit,
        "-p",
        other,
        "-m",
        `Merge upstream: ${branches.join(", ")}`,
      ]);
    }
    return commit;
  }

  /** The repository's files at a commit (the planner's repo map). */
  async listFiles(cache: string, ref: string): Promise<string[]> {
    const out = await this.text(["--git-dir", cache, "ls-tree", "-r", "--name-only", ref]);
    return out ? out.split("\n") : [];
  }

  /** Commits whatever the agent left in the worktree to its branch in the runner's cache, and returns the diff. */
  async collect(w: PreparedWorktree, attemptId: string, message: string): Promise<CollectedResult> {
    await mkdir(join(this.root, "index"), { recursive: true });
    const index = join(this.root, "index", attemptId);
    const env = { GIT_DIR: w.cache, GIT_WORK_TREE: w.path, GIT_INDEX_FILE: index };
    try {
      await this.git(["read-tree", w.base], { env, cwd: w.path });
      await this.git(["add", "-A", "--", "."], { env, cwd: w.path });
      // .brio/ holds what Brio hands the agent (prompt, brief, handoffs); it is never part of the result.
      await this.git(["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ".brio"], { env, cwd: w.path });
      const tree = await this.text(["write-tree"], { env, cwd: w.path });
      const baseTree = await this.text(["rev-parse", `${w.base}^{tree}`], { env, cwd: w.path });
      if (tree === baseTree) return { commit: null, diff: Buffer.alloc(0), diffTruncated: false, files: [] };
      const commit = await this.text(["commit-tree", tree, "-p", w.base, "-m", message], {
        env,
        cwd: w.path,
      });
      await this.git(["update-ref", `refs/heads/${w.branch}`, commit], { env, cwd: w.path });

      const raw = (
        await this.git(["diff", "--binary", "--no-color", "--no-ext-diff", "--no-textconv", w.base, commit], {
          env,
        })
      ).stdout;
      const diffTruncated = raw.length > LIMITS.diffBytes;
      const names = (
        await this.git(["diff", "--name-status", "-z", "--no-renames", w.base, commit], { env })
      ).stdout
        .toString("utf8")
        .split("\0")
        .filter(Boolean);
      const files: ChangedFile[] = [];
      for (let k = 0; k + 1 < names.length && files.length < LIMITS.files; k += 2) {
        const status = STATUS[(names[k] ?? "M")[0] ?? "M"] ?? "modified";
        const path = names[k + 1] ?? "";
        if (status === "deleted") {
          files.push({ path, status });
          continue;
        }
        // Read the committed blob, not the worktree file: a symlink stays a link, never followed on the host.
        const blob = (await this.git(["cat-file", "blob", `${commit}:${path}`], { env })).stdout;
        files.push({
          path,
          status,
          sha256: createHash("sha256").update(blob).digest("hex"),
          size: blob.length,
          ...(blob.length <= LIMITS.fileBytes ? { content: blob } : {}),
        });
      }
      return { commit, diff: diffTruncated ? raw.subarray(0, LIMITS.diffBytes) : raw, diffTruncated, files };
    } finally {
      await rm(index, { force: true });
    }
  }

  async remove(w: Pick<PreparedWorktree, "path">): Promise<void> {
    await rm(w.path, { recursive: true, force: true });
  }
}
