import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = { title: "Scoreboard" };

export default function Page() {
  return (
    <EmptyState
      label="scoreboard"
      command={`brio scores --task-type code.feature`}
      title="Nothing to score yet"
      milestone="M4"
    >
      Every verdict updates which agent wins at which task type, at what cost and how fast. Run a few missions
      and the scoreboard fills in.
    </EmptyState>
  );
}
