// The verifier's runner-side checks (ROUTING §4.1). Each result is recorded on the attempt's checklist
// (attempts.checks) with a check.result event; the orchestrator decides the verdict.
//   tests, typecheck, lint, build: commands in a fresh sandbox on the attempt's branch (registries and git only)
//   a11y, lighthouse: headless Chromium audits in the web sandbox, against files served from inside it (no network)
//   link_check: every link in the result answers (each hop through the URL guard)
//   fact_check (first stage): the cited sources are fetched for the agent that judges the claims

import { join } from "node:path";
import {
  type AttemptChecks,
  type CheckItem,
  type Dispatch,
  type FetchLike,
  followRedirects,
  type Logger,
} from "@brio/adapters";
import {
  CODE_HOSTS,
  citedSources,
  extractLinks,
  PROFILES,
  readAxe,
  readLighthouse,
  type SandboxSpec,
} from "@brio/core";
import { type Db, type EventWriter, schema } from "@brio/db";
import type { Redactor } from "@brio/vault";
import { and, eq, inArray, sql } from "drizzle-orm";
import { ensureImage, type ImageSet } from "./images";
import { DockerSandbox } from "./sandbox/docker-sandbox";
import { Worktrees } from "./worktree";

const { artifacts, attempts, blobs, tasks } = schema;

export const COMMAND_CHECKS = new Set(["tests", "typecheck", "lint", "build"]);
export const WEB_CHECKS = new Set(["a11y", "lighthouse"]);
const OUTPUT_TAIL = 4000;
const MAX_LINKS = 50;
const MAX_SOURCES = 10;
const SOURCE_BYTES = 1_500_000;
const SOURCE_TEXT = 12_000;
const TEXT_FILE = /\.(md|mdx|markdown|txt|html?|rst|adoc)$/i;

/** Whether a check item is the runner's to run now. */
export function runnerOwns(i: CheckItem): boolean {
  if (i.status !== "pending") return false;
  if (i.kind === "fact_check") return i.stage !== "review";
  return isCommand(i) || WEB_CHECKS.has(i.kind) || i.kind === "link_check";
}

/** Command checks, and contract conformance decided by a command (a type check against the contract's types). */
const isCommand = (i: CheckItem) =>
  COMMAND_CHECKS.has(i.kind) || (i.kind === "contract_conformance" && !!i.command);

export interface CheckDeps {
  db: Db;
  events: EventWriter;
  redactor: Redactor;
  log: Logger;
  runnerId: string;
  dir: string;
  images: ImageSet;
  proxyAllowPrivate?: boolean;
  /** Guarded fetch for links and sources found in results (each redirect hop is checked again). */
  fetch: FetchLike;
}

export const CHECK_SANDBOX: SandboxSpec = {
  profile: "code-standard",
  ...PROFILES["code-standard"],
  timeoutMinutes: 20,
  network: { mode: "allowlist", hosts: [...CODE_HOSTS] },
  worktree: "rw",
};

const WEB_SANDBOX: SandboxSpec = { ...CHECK_SANDBOX, network: { mode: "none" }, worktree: "ro" };

/** Readable text from an HTML page: no scripts, styles or tags; entities for the common characters. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

export class CheckExecutor {
  private readonly worktrees: Worktrees;
  constructor(private readonly deps: CheckDeps) {
    this.worktrees = new Worktrees(deps.dir);
  }

  /** Runs the attempt's pending runner checks. Safe to call twice: only pending items run. */
  async run(attemptId: string, signal?: AbortSignal): Promise<void> {
    const { deps } = this;
    const [a] = await deps.db.select().from(attempts).where(eq(attempts.id, attemptId));
    const checks = a?.checks as AttemptChecks | null | undefined;
    const dispatch = a?.dispatch as Dispatch | null | undefined;
    if (!a || !checks || !dispatch) return;
    const pending = checks.items.filter(runnerOwns);
    if (!pending.length) return;
    const [task] = await deps.db
      .select({ missionId: tasks.missionId })
      .from(tasks)
      .where(eq(tasks.id, a.taskId));
    if (!task) return;
    const record = (item: CheckItem) => this.record(attemptId, task.missionId, a.workspaceId, a.taskId, item);

    const fetching = pending.filter((i) => i.kind === "link_check" || i.kind === "fact_check");
    if (fetching.length) {
      const text = await this.resultText(attemptId);
      for (const item of fetching) {
        if (signal?.aborted) return;
        await record(
          item.kind === "link_check" ? await this.linkCheck(item, text) : await this.fetchSources(item, text),
        );
      }
    }

    const commands = pending.filter(isCommand);
    const web = pending.filter((i) => WEB_CHECKS.has(i.kind));
    if (!commands.length && !web.length) return;
    if (!a.worktreeRef) {
      for (const item of [...commands, ...web])
        await record({
          ...item,
          status: "failed",
          summary: `${item.kind} needs files to check; this task produced none`,
        });
      return;
    }

    let worktree: Awaited<ReturnType<Worktrees["prepare"]>> | null = null;
    const id = `check-${attemptId}`;
    try {
      // The attempt's branch is already in the cache; nothing new is needed from the remote.
      const cache = await this.worktrees.cache(
        dispatch.repo ? { repo: dispatch.repo } : { missionId: task.missionId },
        { fetch: false },
      );
      worktree = await this.worktrees.prepare({
        attemptId: id,
        missionId: task.missionId,
        taskKey: `${dispatch.taskKey}-checks`,
        bases: [a.worktreeRef],
        cacheOverride: cache,
      });
      if (commands.length)
        await this.inSandbox(id, worktree.path, "base", CHECK_SANDBOX, commands, record, signal);
      if (web.length) {
        // Audits of a page served by its own command need its dependencies, so those get registries and git.
        const spec = web.some((i) => i.command) ? { ...CHECK_SANDBOX, worktree: "rw" as const } : WEB_SANDBOX;
        await this.inSandbox(`${id}-web`, worktree.path, "web", spec, web, record, signal);
      }
    } catch (err) {
      const message = deps.redactor.redact((err as Error).message);
      const [row] = await deps.db
        .select({ checks: attempts.checks })
        .from(attempts)
        .where(eq(attempts.id, attemptId));
      const still = new Set(
        ((row?.checks as AttemptChecks | null)?.items ?? []).filter(runnerOwns).map((i) => i.index),
      );
      for (const item of [...commands, ...web].filter((i) => still.has(i.index)))
        await record({ ...item, status: "failed", summary: `could not run the check: ${message}` });
    } finally {
      if (worktree) await this.worktrees.remove(worktree).catch(() => {});
    }
  }

  private async inSandbox(
    id: string,
    worktree: string,
    image: "base" | "web",
    spec: SandboxSpec,
    items: CheckItem[],
    record: (i: CheckItem) => Promise<void>,
    signal?: AbortSignal,
  ) {
    const { deps } = this;
    let sandbox: DockerSandbox | null = null;
    try {
      sandbox = await DockerSandbox.create({
        attemptId: id,
        runnerId: deps.runnerId,
        spec,
        image: await ensureImage(deps.images, image),
        images: { ...deps.images, proxy: await ensureImage(deps.images, "proxy") },
        worktree,
        scratchDir: join(deps.dir, "scratch"),
        ...(deps.proxyAllowPrivate ? { proxyAllowPrivate: true } : {}),
      });
      for (const item of items) {
        if (signal?.aborted) break;
        const started = performance.now();
        if (isCommand(item)) {
          const r = await sandbox.exec(item.command ?? "false", { timeoutMs: 10 * 60_000 });
          const raw = `${r.stdout}\n${r.stderr}`.trim();
          await record({
            ...item,
            status: r.exitCode === 0 ? "passed" : "failed",
            exitCode: r.exitCode,
            output: deps.redactor.redact(raw.length > OUTPUT_TAIL ? raw.slice(-OUTPUT_TAIL) : raw),
            durationMs: Math.round(performance.now() - started),
            summary: `${item.command} exited ${r.exitCode}`,
          });
        } else {
          await record({
            ...(await this.audit(sandbox, item)),
            durationMs: Math.round(performance.now() - started),
          });
        }
      }
    } finally {
      await sandbox?.destroy().catch(() => {});
    }
  }

  /** An a11y or Lighthouse audit: of a file in the worktree, or of a page a start command serves. */
  private async audit(sandbox: DockerSandbox, item: CheckItem): Promise<CheckItem> {
    const p = item.params ?? {};
    const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    const target = item.command
      ? `--url ${q(String(p.url ?? "http://127.0.0.1:3000/"))} --wait 120`
      : `--path ${q(String(p.path ?? "index.html"))}`;
    const extra =
      item.kind === "lighthouse" && p.minimums && typeof p.minimums === "object"
        ? ` --categories ${q(Object.keys(p.minimums as object).join(","))}`
        : "";
    const run = `brio-audit ${item.kind} ${target}${extra}`;
    const command = item.command ? `(${item.command}) >/tmp/brio-server.log 2>&1 & ${run}` : run;
    const r = await sandbox.exec(command, { timeoutMs: 10 * 60_000 });
    const last = r.stdout.trim().split("\n").at(-1) ?? "";
    let json: unknown;
    try {
      json = JSON.parse(last);
    } catch {
      json = null;
    }
    const error = (json as { error?: string } | null)?.error;
    if (!json || error)
      return {
        ...item,
        status: "failed",
        exitCode: r.exitCode,
        summary: `the ${item.kind} audit could not run: ${error ?? "no report"}`,
        output: this.deps.redactor.redact(`${r.stderr}`.slice(-OUTPUT_TAIL)),
      };
    if (item.kind === "a11y") {
      const verdict = readAxe(json, { ...(p.minImpact ? { minImpact: p.minImpact as "serious" } : {}) });
      const violations =
        (json as { violations?: Array<{ id: string; impact: string; help: string }> }).violations ?? [];
      return {
        ...item,
        status: verdict.passed ? "passed" : "failed",
        exitCode: r.exitCode,
        summary: verdict.summary,
        details: violations.map((v) => `${v.id} (${v.impact}): ${v.help}`).slice(0, 20),
      };
    }
    const minimums = (p.minimums as Record<string, number> | undefined) ?? {
      performance: 0.8,
      accessibility: 0.9,
    };
    const verdict = readLighthouse(json, minimums);
    return {
      ...item,
      status: verdict.passed ? "passed" : "failed",
      exitCode: r.exitCode,
      summary: verdict.summary,
      details: ((json as { failing?: string[] }).failing ?? []).map((id) => `failing audit: ${id}`),
    };
  }

  /** The result's readable text: the agent's report and the text files it wrote. */
  private async resultText(attemptId: string): Promise<string> {
    const rows = await this.deps.db
      .select({ kind: artifacts.kind, meta: artifacts.meta, bytes: blobs.bytes })
      .from(artifacts)
      .innerJoin(blobs, and(eq(blobs.workspaceId, artifacts.workspaceId), eq(blobs.sha256, artifacts.sha256)))
      .where(and(eq(artifacts.attemptId, attemptId), inArray(artifacts.kind, ["report", "file", "doc"])));
    return rows
      .filter((r) => r.kind !== "file" || TEXT_FILE.test(String((r.meta as { path?: string }).path ?? "")))
      .map((r) => r.bytes.toString("utf8"))
      .join("\n\n");
  }

  private async probe(url: string): Promise<{ ok: boolean; status: number | null; why?: string }> {
    const once = async (method: "HEAD" | "GET") => {
      const { response } = await followRedirects(this.deps.fetch, url, {
        method,
        signal: AbortSignal.timeout(10_000),
        headers: { "user-agent": "brio-link-check" },
      });
      await response.body?.cancel().catch(() => {});
      return response.status;
    };
    try {
      let status = await once("HEAD");
      // Some servers refuse HEAD; ask again with GET before calling the link broken.
      if (status === 405 || status === 403 || status === 501) status = await once("GET");
      return { ok: status < 400, status };
    } catch (err) {
      return { ok: false, status: null, why: (err as Error).message };
    }
  }

  private async linkCheck(item: CheckItem, text: string): Promise<CheckItem> {
    const ignore = ((item.params?.ignore as string[] | undefined) ?? []).filter(Boolean);
    const links = extractLinks(text)
      .filter((l) => !ignore.some((p) => l.includes(p)))
      .slice(0, Number(item.params?.max ?? MAX_LINKS));
    if (!links.length) return { ...item, status: "passed", summary: "no links to check" };
    const started = performance.now();
    const results = await pool(links, 4, async (url) => ({ url, ...(await this.probe(url)) }));
    const broken = results.filter((r) => !r.ok);
    return {
      ...item,
      status: broken.length ? "failed" : "passed",
      durationMs: Math.round(performance.now() - started),
      summary: broken.length
        ? `${broken.length} of ${links.length} link(s) broken: ${broken
            .slice(0, 5)
            .map((b) => `${b.url} (${b.status ?? b.why})`)
            .join(", ")}`
        : `all ${links.length} link(s) answer`,
      details: broken.map((b) => `${b.url}: ${b.status ?? b.why}`),
    };
  }

  /** fact_check, first stage: fetch each cited source's text for the agent that judges the claims. */
  private async fetchSources(item: CheckItem, text: string): Promise<CheckItem> {
    const cited = citedSources(text).slice(0, MAX_SOURCES);
    if (!cited.length)
      return {
        ...item,
        status: "failed",
        summary: "no numbered sources to check (expected lines like `[1]: https://…`)",
      };
    const sources = await pool(cited, 4, async (s) => {
      try {
        const { response } = await followRedirects(this.deps.fetch, s.url, {
          signal: AbortSignal.timeout(20_000),
          headers: { "user-agent": "brio-fact-check", accept: "text/html,text/plain,*/*" },
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          return { url: s.url, ok: false, text: `HTTP ${response.status}`, claims: s.claims };
        }
        const raw = new TextDecoder().decode((await response.arrayBuffer()).slice(0, SOURCE_BYTES));
        const html =
          /html/i.test(response.headers.get("content-type") ?? "") || /<html|<body/i.test(raw.slice(0, 500));
        const body = (html ? htmlToText(raw) : raw).slice(0, SOURCE_TEXT);
        return { url: s.url, ok: true, text: this.deps.redactor.redact(body), claims: s.claims };
      } catch (err) {
        return { url: s.url, ok: false, text: (err as Error).message, claims: s.claims };
      }
    });
    return {
      ...item,
      status: "pending",
      stage: "review",
      sources,
      summary: `fetched ${sources.filter((s) => s.ok).length} of ${sources.length} cited source(s); an agent checks the claims`,
    };
  }

  private async record(
    attemptId: string,
    missionId: string,
    workspaceId: string,
    taskId: string,
    item: CheckItem,
  ) {
    await this.deps.db.transaction(async (tx) => {
      // Lock the attempt row so concurrent updates to its checklist serialise.
      await tx.execute(sql`select 1 from attempts where id = ${attemptId} for update`);
      const [row] = await tx
        .select({ checks: attempts.checks })
        .from(attempts)
        .where(eq(attempts.id, attemptId));
      const checks = row?.checks as AttemptChecks | undefined;
      if (!checks) return;
      checks.items = checks.items.map((i) => (i.index === item.index ? item : i));
      await tx
        .update(attempts)
        .set({ checks: checks as unknown as Record<string, unknown> })
        .where(eq(attempts.id, attemptId));
      const settled = item.status === "passed" || item.status === "failed";
      await this.deps.events.append(tx, {
        workspaceId,
        missionId,
        taskId,
        attemptId,
        type: "check.result",
        actor: "system",
        payload: {
          index: item.index,
          kind: item.kind,
          command: item.command ?? null,
          // null while a check moves to its next stage (a fact check waiting for its agent).
          passed: settled ? item.status === "passed" : null,
          exitCode: item.exitCode ?? null,
          summary: item.summary ?? "",
          output: item.output ?? "",
          details: item.details ?? [],
          durationMs: item.durationMs ?? null,
        },
      });
    });
  }
}
