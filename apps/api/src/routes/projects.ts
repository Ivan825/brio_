// Projects: the repository a mission works on. A git URL (https) in the cloud; a local path too when the deployment
// allows it (self-host, local development), because the runner clones it from its own disk.
import { isAbsolute } from "node:path";
import { schema } from "@brio/db";
import { ProjectKind } from "@brio/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { HttpError, one, requireMember, requireSession, workspaceFor } from "../http";

const { projects } = schema;

const CreateProject = z.object({
  name: z.string().trim().min(1).max(80),
  kind: ProjectKind.default("git"),
  repoUrl: z.string().trim().min(1).max(2000).optional(),
  defaultBranch: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._/-]{1,200}$/, "a branch name")
    .optional(),
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
    return {
      projects: rows.map(({ id, name, kind, repoUrl, defaultBranch, createdAt }) => ({
        id,
        name,
        kind,
        repoUrl,
        defaultBranch,
        createdAt,
      })),
    };
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
    const row = one(
      await ctx.db
        .insert(projects)
        .values({
          workspaceId,
          name: body.name,
          kind: body.kind,
          repoUrl: body.repoUrl ?? null,
          defaultBranch: body.defaultBranch ?? null,
        })
        .returning(),
      "project",
    );
    return reply.status(201).send({
      project: {
        id: row.id,
        name: row.name,
        kind: row.kind,
        repoUrl: row.repoUrl,
        defaultBranch: row.defaultBranch,
      },
    });
  });
}
