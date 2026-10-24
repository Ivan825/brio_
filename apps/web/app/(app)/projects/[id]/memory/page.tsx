import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-api";
import type { ProjectSummary } from "@/lib/types";
import { type MemoryItem, MemoryView } from "./memory-view";

export const metadata: Metadata = { title: "Project memory" };
export const dynamic = "force-dynamic";

export default async function MemoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [projects, memory] = await Promise.all([
    serverApi<{ projects: ProjectSummary[] }>("/v1/projects"),
    serverApi<{ items: MemoryItem[] }>(`/v1/projects/${id}/memory`),
  ]);
  const project = projects.data?.projects.find((p) => p.id === id);
  if (!project || memory.status === 404) notFound();
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-1">
        <p className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
          <Link href="/projects" className="text-focus hover:underline">
            projects
          </Link>{" "}
          · memory
        </p>
        <h1 className="text-xl font-semibold tracking-tight">What Brio remembers about {project.name}</h1>
        <p className="text-sm text-fg-muted">
          Built from every mission on this project: decisions and why, contracts, the prompts behind changes,
          the files they touched. Every agent gets the part that concerns its task before it starts. Correct
          what is wrong; forget what should not be carried forward.
        </p>
      </header>
      <MemoryView projectId={id} items={memory.data?.items ?? []} />
    </div>
  );
}
