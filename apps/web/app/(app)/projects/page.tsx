import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { getWorkspaces, serverApi } from "@/lib/server-api";
import type { ProjectSummary, RunnerSummary } from "@/lib/types";
import { NewProject, ProjectList } from "./project-forms";

export const metadata: Metadata = { title: "Projects" };
export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const { workspaces } = await getWorkspaces();
  const active = workspaces.find((w) => w.active);
  if (!active)
    return (
      <EmptyState label="projects" command="brio workspace create acme" title="Create a workspace first">
        Projects are the repositories missions work on. They live in a workspace.
      </EmptyState>
    );
  const [{ data }, runners] = await Promise.all([
    serverApi<{ projects: ProjectSummary[] }>("/v1/projects"),
    serverApi<{ runners: RunnerSummary[] }>("/v1/runners"),
  ]);
  const projects = data?.projects ?? [];
  const canEdit = active.role === "owner" || active.role === "admin";
  const canCreate = canEdit || active.role === "member";
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-8">
      <header className="flex flex-col gap-1">
        <p className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">projects</p>
        <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
        <p className="text-sm text-fg-muted">
          The repositories missions work on. Agents get a fresh clone in their sandbox; finished work comes
          back as a branch, and a pull request on GitHub, only after you approve it.
        </p>
      </header>
      {projects.length > 0 && <ProjectList projects={projects} canEdit={canEdit} />}
      {canCreate && <NewProject runners={runners.data?.runners ?? []} />}
    </div>
  );
}
