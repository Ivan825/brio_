import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { getWorkspaces, serverApi } from "@/lib/server-api";
import { Budgets, type BudgetView, Ledger, Policies, type PolicyView } from "./governance-ui";
import { Mandate, type MandateView } from "./mandate";
import { Usage, type UsageView } from "./usage";

export const metadata: Metadata = { title: "Governance" };
export const dynamic = "force-dynamic";

export default async function GovernancePage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const asked = Number((await searchParams).days);
  const days = [7, 30, 90].includes(asked) ? asked : 30;
  const { workspaces } = await getWorkspaces();
  const active = workspaces.find((w) => w.active);
  if (!active)
    return (
      <EmptyState label="governance" command="brio workspace create acme" title="Create a workspace first">
        Budgets, policies and the audit ledger belong to a workspace.
      </EmptyState>
    );
  const admin = active.role === "owner" || active.role === "admin";
  const [budgets, policies, mandate, usage] = await Promise.all([
    serverApi<BudgetView>("/v1/budgets"),
    serverApi<{ policies: PolicyView[] }>("/v1/policies"),
    serverApi<{ mandate: MandateView }>("/v1/integrations/mandate"),
    serverApi<{ usage: UsageView }>(`/v1/usage?days=${days}`),
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
      {usage.data && <Usage view={usage.data.usage} days={days} />}
      {budgets.data && <Budgets view={budgets.data} canEdit={admin} />}
      <Policies policies={policies.data?.policies ?? []} canEdit={admin} />
      {mandate.data && <Mandate view={mandate.data.mandate} canEdit={admin} />}
      {admin && <Ledger />}
    </div>
  );
}
