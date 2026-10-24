import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { getWorkspaces, serverApi } from "@/lib/server-api";
import type { AgentSummary } from "@/lib/types";
import { ChatApp, type ChatListItem } from "./chat-app";

export const metadata: Metadata = { title: "Chat" };
export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const { activeWorkspaceId } = await getWorkspaces();
  if (!activeWorkspaceId)
    return (
      <EmptyState label="chat" command="brio workspace create acme" title="Create a workspace first">
        Chats, agents and budgets live in a workspace. Use the workspace menu in the header to create one.
      </EmptyState>
    );
  const [chats, agents] = await Promise.all([
    serverApi<{ chats: ChatListItem[] }>("/v1/chats"),
    serverApi<{ agents: AgentSummary[] }>("/v1/agents"),
  ]);
  return <ChatApp chats={chats.data?.chats ?? []} agents={agents.data?.agents ?? []} initial={null} />;
}
