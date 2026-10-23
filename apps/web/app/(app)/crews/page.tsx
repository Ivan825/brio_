import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { getWorkspaces, serverApi } from "@/lib/server-api";
import type { AgentSummary, CrewSummary } from "@/lib/types";
import { CrewForm, CrewList } from "./crew-forms";

export const metadata: Metadata = { title: "Crews" };
export const dynamic = "force-dynamic";

export default async function CrewsPage() {
  const { workspaces } = await getWorkspaces();
  const active = workspaces.find((w) => w.active);
  if (!active)
    return (
      <EmptyState label="crews" command="brio workspace create acme" title="Create a workspace first">
        A crew is a saved set of a workspace&apos;s agents.
      </EmptyState>
    );
  const [crews, agents] = await Promise.all([
    serverApi<{ crews: CrewSummary[] }>("/v1/crews"),
    serverApi<{ agents: AgentSummary[] }>("/v1/agents"),
  ]);
  const list = crews.data?.crews ?? [];
  const all = agents.data?.agents ?? [];
  const canEdit = active.role !== "viewer";
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-8">
      <header className="flex flex-col gap-1">
        <p className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">crews</p>
        <h1 className="text-xl font-semibold tracking-tight">Crews</h1>
        <p className="text-sm text-fg-muted">
          A saved set of agents, and which of them takes each kind of task. A mission given to a crew uses
          only its agents; reviews still go to another vendor when the crew has one.
        </p>
      </header>
      {list.length > 0 && <CrewList crews={list} agents={all} canEdit={canEdit} />}
      {canEdit &&
        (all.length ? (
          <CrewForm agents={all} />
        ) : (
          <p className="text-sm text-fg-muted">Add agents first: a crew is made of them.</p>
        ))}
    </div>
  );
}
