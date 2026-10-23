import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = { title: "Missions" };

export default function Page() {
  return (
    <EmptyState
      label="missions"
      command={`brio run "add passkey sign-in, with tests"`}
      title="No missions yet"
    >
      A mission is one goal. Brio plans it into tasks, hands each to the agent best at it, has another vendor
      check the result, and streams every step here.
    </EmptyState>
  );
}
