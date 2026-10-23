import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { StatusChip } from "@/components/status-chip";
import { getWorkspaces, serverApi } from "@/lib/server-api";
import { NewMission } from "./new-mission";

export const metadata: Metadata = { title: "Missions" };

interface MissionRow {
  id: string;
  title: string;
  status: string;
  lastEventSeq: number;
  createdAt: string;
}

export default async function MissionsPage() {
  const { activeWorkspaceId } = await getWorkspaces();
  if (!activeWorkspaceId) {
    return (
      <EmptyState label="missions" command="brio workspace create acme" title="Create a workspace first">
        Missions, connectors and budgets live in a workspace. Use the workspace menu in the header to create
        one.
      </EmptyState>
    );
  }
  const { data } = await serverApi<{ missions: MissionRow[] }>("/v1/missions");
  const missions = data?.missions ?? [];

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-8">
      {missions.length === 0 ? (
        <EmptyState
          label="missions"
          command={'brio run "add passkey sign-in, with tests"'}
          title="No missions yet"
        >
          A mission is one goal. Brio plans it into tasks, hands each to the agent best at it, has another
          vendor check the result, and streams every step here.
        </EmptyState>
      ) : (
        <h1 className="text-xl font-semibold tracking-tight">Missions</h1>
      )}
      <NewMission />
      {missions.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Missions">
          {missions.map((m) => (
            <li key={m.id}>
              <Link
                href={`/missions/${m.id}`}
                className="flex items-center gap-4 px-4 py-3 hover:bg-surface-2"
              >
                <span className="min-w-0 flex-1 truncate">{m.title}</span>
                <span className="hidden font-mono text-2xs tabular-nums text-fg-subtle sm:inline">
                  {m.lastEventSeq} events
                </span>
                <StatusChip status={m.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
