import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = { title: "Settings" };

export default function Page() {
  return (
    <EmptyState label="settings" command={`brio workspace show`} title="Workspace settings">
      Name, members and invitations for this workspace. Budgets, policies and approvals arrive with
      governance.
    </EmptyState>
  );
}
