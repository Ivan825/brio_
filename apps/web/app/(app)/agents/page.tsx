import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = { title: "Agents" };

export default function Page() {
  return (
    <EmptyState
      label="agents"
      command={`brio agents new --connector openai --role reviewer`}
      title="No agents yet"
      milestone="M1"
    >
      An agent is a connector, a model, a role prompt and limits on tokens, time and cost. Brio routes tasks
      to agents and learns which one wins at what.
    </EmptyState>
  );
}
