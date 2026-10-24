// What a mission starts from besides its goal (PRD F1): files a person attaches, and an issue link read once when the
// mission is created. Both reach every attempt of the mission as attachments (text inline, binaries by name) and, for
// agents with a worktree, as files under .brio/inputs/. Issue text is someone else's words: agents get it as untrusted
// content, like handoff packets.
import { createHash } from "node:crypto";
import type { AttachmentRef } from "@brio/adapters";
import { type DbOrTx, schema } from "@brio/db";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "./context";
import { HttpError } from "./http";

const { blobs, projects } = schema;

export const MAX_INPUT_FILES = 10;
export const MAX_INPUT_BYTES = 2 * 1024 * 1024;
/** Text attachments are inlined up to this many characters each. */
const INLINE_CHARS = 50_000;
const MAX_COMMENTS = 20;

export const InputFile = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9._ -]+$/, "a plain file name")
    .refine((n) => !n.startsWith("."), "a plain file name"),
  content: z.string().max(Math.ceil((MAX_INPUT_BYTES * 4) / 3) + 4),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
  contentType: z.string().trim().max(100).optional(),
});
export type InputFile = z.input<typeof InputFile>;

/** Decodes and stores attached files as blobs; returns what the mission keeps about them. */
export async function storeInputFiles(
  db: DbOrTx,
  workspaceId: string,
  files: z.infer<typeof InputFile>[],
): Promise<schema.MissionInputs["files"]> {
  if (files.length > MAX_INPUT_FILES)
    throw new HttpError(422, `attach at most ${MAX_INPUT_FILES} files`, "too_many_files");
  const names = new Set<string>();
  const decoded = files.map((f) => {
    if (names.has(f.name)) throw new HttpError(422, `two files are named ${f.name}`, "duplicate_file");
    names.add(f.name);
    const bytes = Buffer.from(f.content, f.encoding === "base64" ? "base64" : "utf8");
    return { f, bytes };
  });
  const total = decoded.reduce((n, d) => n + d.bytes.length, 0);
  if (total > MAX_INPUT_BYTES)
    throw new HttpError(
      422,
      `attached files come to more than ${MAX_INPUT_BYTES / 1024 / 1024} MB`,
      "files_too_large",
    );
  const out: NonNullable<schema.MissionInputs["files"]> = [];
  for (const { f, bytes } of decoded) {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const text = f.encoding === "utf8" || isText(bytes);
    const contentType = f.contentType ?? (text ? "text/plain; charset=utf-8" : "application/octet-stream");
    await db
      .insert(blobs)
      .values({ workspaceId, sha256, contentType, size: bytes.length, bytes })
      .onConflictDoNothing();
    out.push({ name: f.name, sha256, size: bytes.length, contentType, text });
  }
  return out;
}

/** UTF-8 without NUL bytes reads as text. */
function isText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  return Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes);
}

const GITHUB_ISSUE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)\/?(?:[#?].*)?$/;

/**
 * Reads a GitHub issue or pull request (title, body, state, the first comments) with the project's token when the
 * project is that repository, else anonymously (public repositories). Other hosts are refused with a clear message.
 */
export async function readIssue(
  ctx: AppContext,
  workspaceId: string,
  url: string,
  projectId: string | undefined,
): Promise<NonNullable<schema.MissionInputs["issue"]>> {
  const m = GITHUB_ISSUE.exec(url);
  // "." or ".." as owner or repository would walk the API path the project's token is sent to.
  if (!m || [m[1], m[2]].some((p) => p === "." || p === ".."))
    throw new HttpError(
      422,
      "issue links are read from GitHub (https://github.com/<owner>/<repo>/issues/<n>); paste other issues into the goal",
      "unsupported_issue_link",
    );
  const [, owner, repo, number] = m;
  let token: string | null = null;
  if (projectId) {
    const [p] = await ctx.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)));
    const sameRepo =
      p?.repoUrl &&
      (p.repoUrl.replace(/\.git$/, "").toLowerCase() ===
        `https://github.com/${owner}/${repo}`.toLowerCase() ||
        ((p.settings.github as { repo?: string } | undefined)?.repo ?? "").toLowerCase() ===
          `${owner}/${repo}`.toLowerCase());
    if (sameRepo && p.credentialRef)
      token = (await ctx.vault.reveal(ctx.db, workspaceId, p.credentialRef)).reveal();
  }
  const get = async (path: string) => {
    const res = await ctx.fetch(`${ctx.config.BRIO_GITHUB_API_URL.replace(/\/+$/, "")}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "brio",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (res.status === 404)
      throw new HttpError(
        422,
        `cannot read ${owner}/${repo}#${number}: not found${token ? "" : " (a private repository needs a project with a git token)"}`,
        "issue_unreadable",
      );
    if (!res.ok)
      throw new HttpError(
        422,
        `cannot read ${owner}/${repo}#${number} (GitHub HTTP ${res.status})`,
        "issue_unreadable",
      );
    return res.json() as Promise<unknown>;
  };
  const issue = (await get(`/repos/${owner}/${repo}/issues/${number}`)) as {
    title?: string;
    body?: string | null;
    state?: string;
    comments?: number;
  };
  const comments = issue.comments
    ? ((await get(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=${MAX_COMMENTS}`)) as Array<{
        user?: { login?: string };
        body?: string;
      }>)
    : [];
  return {
    url,
    title: String(issue.title ?? ""),
    body: String(issue.body ?? ""),
    state: String(issue.state ?? "open"),
    comments: comments.slice(0, MAX_COMMENTS).map((c) => `${c.user?.login ?? "someone"}: ${c.body ?? ""}`),
  };
}

/** The mission's inputs as attempt attachments and as files under .brio/inputs/ for agents with a worktree. */
export async function inputsForAttempt(
  db: DbOrTx,
  workspaceId: string,
  inputs: schema.MissionInputs,
): Promise<{
  attachments: AttachmentRef[];
  files: Array<{ path: string; content: string; encoding?: "base64" }>;
}> {
  const attachments: AttachmentRef[] = [];
  const files: Array<{ path: string; content: string; encoding?: "base64" }> = [];
  if (inputs.issue) {
    const i = inputs.issue;
    const text = [
      `# ${i.title} (${i.state})`,
      i.url,
      "",
      i.body,
      ...(i.comments.length ? ["", "## Comments", ...i.comments.map((c) => `- ${c}`)] : []),
    ].join("\n");
    attachments.push({ kind: "issue", ref: i.url, text: text.slice(0, INLINE_CHARS) });
    files.push({ path: "inputs/issue.md", content: text });
  }
  const list = inputs.files ?? [];
  const rows = list.length
    ? await db
        .select()
        .from(blobs)
        .where(
          and(
            eq(blobs.workspaceId, workspaceId),
            inArray(
              blobs.sha256,
              list.map((f) => f.sha256),
            ),
          ),
        )
    : [];
  const bySha = new Map(rows.map((r) => [r.sha256, r]));
  for (const f of list) {
    const blob = bySha.get(f.sha256);
    if (!blob) continue;
    if (!f.text) {
      // Binaries reach agents with a worktree as files; model-API agents see their name only.
      attachments.push({ kind: "file", ref: `inputs/${f.name}`, sha256: f.sha256 });
      files.push({
        path: `inputs/${f.name}`,
        content: Buffer.from(blob.bytes).toString("base64"),
        encoding: "base64",
      });
      continue;
    }
    const text = Buffer.from(blob.bytes).toString("utf8");
    attachments.push({
      kind: "file",
      ref: `inputs/${f.name}`,
      sha256: f.sha256,
      text: text.slice(0, INLINE_CHARS),
    });
    files.push({ path: `inputs/${f.name}`, content: text });
  }
  return { attachments, files };
}
