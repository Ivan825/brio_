// Delivery, the runner side (BUILD_PLAN M8): once a person approves, push a finished mission's integration commit to
// the project repository as a new branch, then open a pull request for it when the repository is on GitHub. The push
// goes to the repository URL itself (never the cache's mirror remote, which would push everything), with the
// project's token in the environment only; the pull request is opened with the same token, so it is the token
// owner's. Both are side effects, so both go to the audit ledger.
import type { FetchLike, Logger } from "@brio/adapters";
import { type MissionReport, renderMissionReport } from "@brio/core";
import { type Db, type DbOrTx, type EventWriter, schema } from "@brio/db";
import type { Ledger } from "@brio/governance";
import type { Redactor, Vault } from "@brio/vault";
import { and, eq } from "drizzle-orm";
import { gitAuthEnv, Worktrees } from "./worktree";

const { deliveries, missions, projects } = schema;

export const GITHUB_API = "https://api.github.com";
/** GitHub refuses pull request bodies over 65,536 characters. */
const MAX_BODY = 60_000;

export interface DeliveryDeps {
  db: Db;
  events: EventWriter;
  ledger: Ledger;
  vault: Vault;
  redactor: Redactor;
  fetch: FetchLike;
  log: Logger;
  dir: string;
  /** The GitHub REST API: api.github.com, or a GitHub Enterprise Server's /api/v3. */
  githubApiUrl?: string;
}

export interface DeliveryJob {
  deliveryId: string;
}

/** owner/name of a github.com repository URL, or of the project's `github.repo` setting. */
export function githubRepoOf(url: string, settings: Record<string, unknown>): string | null {
  const set = (settings.github as { repo?: unknown } | undefined)?.repo;
  if (typeof set === "string" && isOwnerName(set)) return set;
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return m && isOwnerName(`${m[1]}/${m[2]}`) ? `${m[1]}/${m[2]}` : null;
}

/** owner/name, neither part "." or ".." (they would walk the API path the project's token is sent to). */
export function isOwnerName(s: string): boolean {
  const parts = s.split("/");
  return parts.length === 2 && parts.every((p) => /^[\w.-]+$/.test(p) && p !== "." && p !== "..");
}

export class DeliveryExecutor {
  private readonly worktrees: Worktrees;
  constructor(private readonly deps: DeliveryDeps) {
    this.worktrees = new Worktrees(deps.dir);
  }

  async run(job: DeliveryJob): Promise<void> {
    const { deps } = this;
    // Claim it (queued → running) so a duplicate job does nothing.
    const [row] = await deps.db
      .update(deliveries)
      .set({ status: "running", error: null })
      .where(and(eq(deliveries.id, job.deliveryId), eq(deliveries.status, "queued")))
      .returning();
    if (!row) return;
    const event = (
      type: "delivery.started" | "delivery.done" | "delivery.failed",
      payload: object,
      db: DbOrTx = deps.db,
    ) =>
      deps.events.append(db, {
        workspaceId: row.workspaceId,
        missionId: row.missionId,
        type,
        actor: "system",
        payload: { deliveryId: row.id, kind: row.kind, branch: row.branch, ...payload },
      });
    await event("delivery.started", { commit: row.commit });

    try {
      const [m] = await deps.db.select().from(missions).where(eq(missions.id, row.missionId));
      const [project] = m?.projectId
        ? await deps.db.select().from(projects).where(eq(projects.id, m.projectId))
        : [];
      if (!project?.repoUrl) throw new Error("the mission's project has no repository");
      const token = project.credentialRef
        ? (await deps.vault.reveal(deps.db, row.workspaceId, project.credentialRef)).reveal()
        : null;

      const cache = await this.worktrees.cache({ repo: { url: row.repo.url } }, { token, fetch: false });
      await this.worktrees.git(["--git-dir", cache, "cat-file", "-e", `${row.commit}^{commit}`]).catch(() => {
        throw new Error("the integration commit is not on this runner; run the merge again");
      });
      await this.worktrees.git(
        ["--git-dir", cache, "push", "-q", "--", row.repo.url, `${row.commit}:refs/heads/${row.branch}`],
        { env: gitAuthEnv(token) },
      );
      await deps.ledger.append(deps.db, {
        workspaceId: row.workspaceId,
        kind: "side_effect",
        payload: {
          action: "git.push",
          deliveryId: row.id,
          missionId: row.missionId,
          repo: row.repo.url,
          branch: row.branch,
          commit: row.commit,
        },
      });

      let pr: { url: string; number: number } | null = null;
      if (row.kind === "pull_request") {
        const repo = githubRepoOf(row.repo.url, project.settings);
        if (!repo) throw new Error("pull requests need a GitHub repository; the branch was pushed");
        if (!token)
          throw new Error("opening a pull request needs a token on the project; the branch was pushed");
        const report = (m?.report as { final?: MissionReport } | null)?.final;
        pr = await this.openPullRequest(repo, token, {
          title: row.title,
          head: row.branch,
          base: row.repo.base,
          body: report ? renderMissionReport(report) : `Delivered by Brio from mission ${row.missionId}.`,
        });
        await deps.ledger.append(deps.db, {
          workspaceId: row.workspaceId,
          kind: "side_effect",
          payload: {
            action: "github.pull_request",
            deliveryId: row.id,
            repo,
            number: pr.number,
            url: pr.url,
          },
        });
      }

      // The status and its event together: whoever sees it done sees why.
      await deps.db.transaction(async (tx) => {
        await tx
          .update(deliveries)
          .set({ status: "done", url: pr?.url ?? null, number: pr?.number ?? null })
          .where(eq(deliveries.id, row.id));
        await event("delivery.done", pr ? { url: pr.url, number: pr.number } : {}, tx);
      });
    } catch (err) {
      const message = deps.redactor.redact((err as Error).message).slice(0, 1000);
      deps.log.warn({ err: message, deliveryId: row.id }, "delivery failed");
      await deps.db.transaction(async (tx) => {
        await tx
          .update(deliveries)
          .set({ status: "failed", error: message })
          .where(eq(deliveries.id, row.id));
        await event("delivery.failed", { error: message }, tx);
      });
    }
  }

  /** Opens the pull request, or finds the open one for the same branch (a retried delivery). */
  private async openPullRequest(
    repo: string,
    token: string,
    pr: { title: string; head: string; base: string | null; body: string },
  ): Promise<{ url: string; number: number }> {
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await this.deps.fetch(
        `${(this.deps.githubApiUrl ?? GITHUB_API).replace(/\/+$/, "")}${path}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "brio",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, json: json as Record<string, unknown> | null, text };
    };
    const base =
      pr.base ??
      (await (async () => {
        const r = await call("GET", `/repos/${repo}`);
        if (r.status !== 200) throw new Error(`GitHub: cannot read ${repo} (HTTP ${r.status})`);
        return String(r.json?.default_branch ?? "main");
      })());
    const body =
      pr.body.length > MAX_BODY ? `${pr.body.slice(0, MAX_BODY)}\n\n…(the full report is in Brio)` : pr.body;
    const made = await call("POST", `/repos/${repo}/pulls`, { title: pr.title, head: pr.head, base, body });
    if (made.status === 201 && made.json)
      return { url: String(made.json.html_url), number: Number(made.json.number) };
    if (made.status === 422 && /already exists/i.test(made.text)) {
      const owner = repo.split("/")[0];
      const open = await call(
        "GET",
        `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${pr.head}`)}`,
      );
      const first = Array.isArray(open.json)
        ? (open.json[0] as Record<string, unknown> | undefined)
        : undefined;
      if (first) return { url: String(first.html_url), number: Number(first.number) };
    }
    const why = (made.json?.message as string | undefined) ?? made.text.slice(0, 200);
    throw new Error(`GitHub refused the pull request (HTTP ${made.status}): ${why}`);
  }
}
