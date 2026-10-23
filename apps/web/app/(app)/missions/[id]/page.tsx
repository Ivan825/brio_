import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-api";
import { MissionBoard, type MissionDetail } from "./mission-board";

export const metadata: Metadata = { title: "Mission" };

export default async function MissionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { status, data } = await serverApi<MissionDetail>(`/v1/missions/${id}`);
  if (status === 404 || status === 400 || !data) notFound();
  return <MissionBoard initial={data} />;
}
