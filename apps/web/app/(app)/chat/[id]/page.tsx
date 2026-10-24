import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-api";
import type { AgentSummary } from "@/lib/types";
import { ChatApp, type ChatListItem, type ChatView } from "../chat-app";

export const metadata: Metadata = { title: "Chat" };
export const dynamic = "force-dynamic";

export default async function ChatThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [view, chats, agents] = await Promise.all([
    serverApi<ChatView>(`/v1/chats/${id}`),
    serverApi<{ chats: ChatListItem[] }>("/v1/chats"),
    serverApi<{ agents: AgentSummary[] }>("/v1/agents"),
  ]);
  if (!view.data) notFound();
  return (
    <ChatApp
      key={id}
      chats={chats.data?.chats ?? []}
      agents={agents.data?.agents ?? []}
      initial={view.data}
    />
  );
}
