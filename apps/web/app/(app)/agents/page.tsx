import type { Metadata } from "next";
import { serverApi } from "@/lib/server-api";
import type { AgentSummary, InstalledConnector, RunnerSummary } from "@/lib/types";
import { AgentBuilder, AgentList } from "./agent-ui";

export const metadata: Metadata = { title: "Agents" };

export default async function Page() {
  const [agents, connectors, runners] = await Promise.all([
    serverApi<{ agents: AgentSummary[] }>("/v1/agents"),
    serverApi<{ connectors: InstalledConnector[] }>("/v1/connectors"),
    serverApi<{ runners: RunnerSummary[] }>("/v1/runners"),
  ]);
  const usable = (connectors.data?.connectors ?? []).filter((c) => c.status !== "disabled");
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-8">
      <header className="flex flex-col gap-2">
        <p className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">agents</p>
        <h1 className="text-xl font-semibold tracking-tight">Agents</h1>
        <p className="max-w-3xl text-fg-muted">
          An agent is a connector, a model, a role prompt and limits on tokens, time and cost. Brio routes
          tasks to agents and learns which one wins at what.
        </p>
      </header>
      <AgentList agents={agents.data?.agents ?? []} />
      <AgentBuilder connectors={usable} runners={runners.data?.runners ?? []} />
    </div>
  );
}
