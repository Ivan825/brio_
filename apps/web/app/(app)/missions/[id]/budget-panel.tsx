"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { FormError, Input } from "@/components/field";
import { api } from "@/lib/api";
import { usd } from "@/lib/format";

/** A spent budget stopped some work: say which, and let a person raise the mission's budget so it goes on (M9). */
export function BudgetPanel({
  missionId,
  budgetUsd,
  reasons,
}: {
  missionId: string;
  budgetUsd?: number;
  reasons: string[];
}) {
  const router = useRouter();
  const [value, setValue] = useState(budgetUsd ? String(Math.ceil(budgetUsd * 2 * 100) / 100) : "");
  const [error, setError] = useState<string | null>(null);
  if (!reasons.length) return null;
  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4"
      data-testid="budget-panel"
    >
      <p className="text-sm text-warning">{reasons[0]?.replace(/^(dispatch: )?budget: /, "Stopped: ")}</p>
      <p className="text-xs text-fg-muted">
        {reasons.length} task{reasons.length === 1 ? "" : "s"} wait. Raise the mission&apos;s budget
        {budgetUsd ? ` (now ${usd(budgetUsd)})` : ""} to let them run again; workspace and agent budgets are
        on the Governance page.
      </p>
      <div className="flex items-center gap-2">
        <Input
          aria-label="New mission budget (USD)"
          type="number"
          min="0"
          step="0.5"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-32"
        />
        <Button
          variant="primary"
          disabled={!Number(value)}
          onClick={async () => {
            setError(null);
            try {
              await api(`/v1/missions/${missionId}/budget`, { method: "PUT", body: { usd: Number(value) } });
              router.refresh();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Raise the budget
        </Button>
      </div>
      <FormError>{error}</FormError>
    </section>
  );
}
