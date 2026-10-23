import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-api";
import type { AgentSummary } from "@/lib/types";
import { MissionBoard, type MissionDetail } from "./mission-board";

export const metadata: Metadata = { title: "Mission" };

export default async function MissionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [{ status, data }, agents] = await Promise.all([
    serverApi<MissionDetail>(`/v1/missions/${id}`),
    serverApi<{ agents: AgentSummary[] }>("/v1/agents"),
  ]);
  if (status === 404 || status === 400 || !data) notFound();
  return <MissionBoard initial={data} agents={agents.data?.agents ?? []} />;
}
