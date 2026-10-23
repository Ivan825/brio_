// Projects: the repository a mission works on. A git URL (https) in the cloud; a local path too when the deployment
// allows it (self-host, local development), because the runner clones it from its own disk.
import { isAbsolute } from "node:path";
import { type DbOrTx, schema } from "@brio/db";
import { ProjectKind } from "@brio/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { HttpError, one, requireMember, requireSession, workspaceFor } from "../http";

const { projects } = schema;

const Branch = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._/-]{1,200}$/, "a branch name");
/** owner/name of the GitHub repository pull requests go to, when the repository URL is not a github.com one. */
const GithubRepo = z
  .string()
  .trim()
  .regex(/^[\w.-]+\/[\w.-]+$/, "owner/name");
/** A git token (GitHub fine-grained or classic, or any host that takes one as a password). Stored in the vault. */
const GitToken = z.string().trim().min(8).max(500);

const CreateProject = z.object({
  name: z.string().trim().min(1).max(80),
  kind: ProjectKind.default("git"),
  repoUrl: z.string().trim().min(1).max(2000).optional(),
  defaultBranch: Branch.optional(),
  gitToken: GitToken.optional(),
  githubRepo: GithubRepo.optional(),
});

const UpdateProject = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  defaultBranch: Branch.nullable().optional(),
  /** null removes the token. */
  gitToken: GitToken.nullable().optional(),
  githubRepo: GithubRepo.nullable().optional(),
});

const Params = z.object({ id: z.uuid() });

type Project = typeof projects.$inferSelect;

const present = (p: Project) => ({
  id: p.id,
  name: p.name,
  kind: p.kind,
  repoUrl: p.repoUrl,
  defaultBranch: p.defaultBranch,
  hasToken: p.credentialRef !== null,
  githubRepo: ((p.settings.github as { repo?: string } | undefined)?.repo ?? null) as string | null,
  createdAt: p.createdAt,
});

export async function projectRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/v1/projects", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s);
    const rows = await ctx.db
      .select()
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)))
      .orderBy(asc(projects.createdAt));
    return { projects: rows.map(present) };
  });

  app.post("/v1/projects", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s, ["owner", "admin", "member"]);
    const body = CreateProject.parse(req.body);
    if (body.repoUrl) {
      if (isAbsolute(body.repoUrl)) {
        if (!ctx.config.allowLocalRepos)
          throw new HttpError(
            422,
            "local repository paths are only allowed in self-hosted setups",
            "local_repo_disabled",
          );
      } else if (/^https:\/\//.test(body.repoUrl)) {
        await ctx.checkUrl(body.repoUrl).catch((e: Error) => {
          throw new HttpError(422, e.message, "unsafe_url");
        });
      } else throw new HttpError(422, "use an https git URL", "unsupported_repo_url");
    }
    const row = await ctx.db.transaction(async (tx) => {
      const made = one(
        await tx
          .insert(projects)
          .values({
            workspaceId,
            name: body.name,
            kind: body.kind,
            repoUrl: body.repoUrl ?? null,
            defaultBranch: body.defaultBranch ?? null,
            settings: body.githubRepo ? { github: { repo: body.githubRepo } } : {},
          })
          .returning(),
        "project",
      );
      if (!body.gitToken) return made;
      return setToken(tx, made, body.gitToken, s.userId);
    });
    return reply.status(201).send({ project: present(row) });
  });

  app.patch("/v1/projects/:id", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s, ["owner", "admin"]);
    const body = UpdateProject.parse(req.body);
    const [p] = await ctx.db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.id, Params.parse(req.params).id),
          eq(projects.workspaceId, workspaceId),
          isNull(projects.deletedAt),
        ),
      );
    if (!p) throw new HttpError(404, "project not found", "not_found");
    const row = await ctx.db.transaction(async (tx) => {
      const settings = { ...p.settings };
      if (body.githubRepo !== undefined) {
        if (body.githubRepo) settings.github = { repo: body.githubRepo };
        else delete settings.github;
      }
      let next = one(
        await tx
          .update(projects)
          .set({
            ...(body.name ? { name: body.name } : {}),
            ...(body.defaultBranch !== undefined ? { defaultBranch: body.defaultBranch } : {}),
            settings,
          })
          .where(eq(projects.id, p.id))
          .returning(),
        "project",
      );
      if (body.gitToken) next = await setToken(tx, next, body.gitToken, s.userId);
      else if (body.gitToken === null && next.credentialRef) {
        next = one(
          await tx.update(projects).set({ credentialRef: null }).where(eq(projects.id, p.id)).returning(),
          "project",
        );
        await ctx.ledger.append(tx, {
          workspaceId,
          kind: "key.removed",
          payload: { projectId: p.id, secretId: p.credentialRef, by: s.userId },
        });
      }
      return next;
    });
    return { project: present(row) };
  });

  /** Seals the token in the vault and points the project at it; the ledger records that a key was added. */
  async function setToken(tx: DbOrTx, p: Project, token: string, userId: string): Promise<Project> {
    const secret = await ctx.vault.put(tx, {
      workspaceId: p.workspaceId,
      label: `project:${p.id}:git:${Date.now()}`,
      value: token,
      createdBy: userId,
    });
    await ctx.ledger.append(tx, {
      workspaceId: p.workspaceId,
      kind: "key.added",
      payload: { projectId: p.id, secretId: secret.id, by: userId },
    });
    return one(
      await tx.update(projects).set({ credentialRef: secret.id }).where(eq(projects.id, p.id)).returning(),
      "project",
    );
  }
}
