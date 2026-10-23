import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = { title: "Connectors" };

export default function Page() {
  return (
    <EmptyState
      label="connectors"
      command={`brio connectors add openai`}
      title="No connectors yet"
      milestone="M1"
    >
      Connectors are how Brio reaches models and agents: APIs with your own keys, coding CLIs, hosted agents,
      MCP and A2A. Keys go into the vault and never into logs or prompts.
    </EmptyState>
  );
}
