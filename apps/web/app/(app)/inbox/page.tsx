import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { serverApi } from "@/lib/server-api";
import { type InboxItem, InboxList } from "./inbox-list";

export const metadata: Metadata = { title: "Inbox" };
export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const { data } = await serverApi<{ items: InboxItem[] }>("/v1/inbox");
  const items = data?.items ?? [];
  // Empty, the empty state is the page's only heading (as on the other screens).
  if (items.length === 0)
    return (
      <EmptyState label="inbox" command="brio approve" title="Nothing is waiting for you">
        When an agent asks something, a result needs a person, or a plan or action needs approval, it shows up
        here.
      </EmptyState>
    );
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-1">
        <p className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">inbox</p>
        <h1 className="text-xl font-semibold tracking-tight">Waiting for you</h1>
        <p className="text-sm text-fg-muted">
          Plans to approve, results to review, agents&apos; questions and actions that need a yes, across
          every mission.
        </p>
      </header>
      <InboxList items={items} />
    </div>
  );
}
