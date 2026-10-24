import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { getWorkspaces, serverApi } from "@/lib/server-api";
import { Budgets, type BudgetView, Ledger, Policies, type PolicyView } from "./governance-ui";

export const metadata: Metadata = { title: "Governance" };
export const dynamic = "force-dynamic";

export default async function GovernancePage() {
  const { workspaces } = await getWorkspaces();
  const active = workspaces.find((w) => w.active);
  if (!active)
    return (
      <EmptyState label="governance" command="brio workspace create acme" title="Create a workspace first">
        Budgets, policies and the audit ledger belong to a workspace.
      </EmptyState>
    );
  const admin = active.role === "owner" || active.role === "admin";
  const [budgets, policies] = await Promise.all([
    serverApi<BudgetView>("/v1/budgets"),
    serverApi<{ policies: PolicyView[] }>("/v1/policies"),
  ]);
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-10 px-6 py-8">
      <header className="flex flex-col gap-1">
        <p className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">governance</p>
        <h1 className="text-xl font-semibold tracking-tight">Governance</h1>
        <p className="text-sm text-fg-muted">
          What the workspace may spend, where its data may go, and the tamper-evident record of everything
          that mattered. {admin ? "" : "Only owners and admins change these."}
        </p>
      </header>
      {budgets.data && <Budgets view={budgets.data} canEdit={admin} />}
      <Policies policies={policies.data?.policies ?? []} canEdit={admin} />
      {admin && <Ledger />}
    </div>
  );
}
