"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Button } from "@/components/button";
import { Chip } from "@/components/chip";
import { FormError, Label, Select, Textarea } from "@/components/field";
import { api } from "@/lib/api";
import { usd } from "@/lib/format";
import type { AgentSummary } from "@/lib/types";

interface PlannedTask {
  key: string;
  type: string;
  title: string;
  dependsOn: string[];
  pinnedAgentId?: string;
  estimate?: { usd: number; minutes: number };
  contract: {
    objective: string;
    acceptance: { kind: string; command?: string }[];
    expectedFootprint?: { paths: string[] };
  };
}

interface Issue {
  task?: string;
  message: string;
}

export interface PlanView {
  version: number;
  status: string;
  origin: string;
  graph: { tasks: PlannedTask[]; assumptions: string[]; questions: string[] };
  lint: {
    errors?: Issue[];
    warnings?: Issue[];
    fixes?: Issue[];
    estimate?: { usd: number; minutes: number } | null;
  };
}

/** The proposed plan: what each task is, who would do it, what lint changed; approve it, edit it or ask for another. */
export function PlanPanel({
  missionId,
  plan,
  agents,
}: {
  missionId: string;
  plan: PlanView;
  agents: AgentSummary[];
}) {
  const router = useRouter();
  const ids = useId();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const errors = plan.lint.errors ?? [];

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const pin = (key: string, agentId: string) =>
    act("pin", () =>
      api(`/v1/missions/${missionId}/plans/${plan.version}/edits`, {
        method: "POST",
        body: { edits: [{ op: "pin", key, agentId: agentId || null }] },
      }),
    );

  return (
    <section
      aria-labelledby="plan-title"
      className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4"
      data-testid="plan-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 id="plan-title" className="font-medium">
            Plan v{plan.version}
          </h2>
          <Chip>{plan.origin === "user" ? "edited" : "proposed"}</Chip>
          {plan.lint.estimate && (
            <Chip title="estimate">
              {usd(plan.lint.estimate.usd)} · {plan.lint.estimate.minutes} min
            </Chip>
          )}
        </div>
        <Button
          variant="primary"
          disabled={busy !== null || errors.length > 0}
          onClick={() =>
            act("approve", () =>
              api(`/v1/missions/${missionId}/plans/${plan.version}/approve`, { method: "POST" }),
            )
          }
        >
          {busy === "approve" ? "Approving…" : "Approve plan"}
        </Button>
      </div>

      {errors.length > 0 && (
        <ul className="flex flex-col gap-1 font-mono text-xs text-danger">
          {errors.map((e) => (
            <li key={`${e.task}-${e.message}`}>
              {e.task ? `${e.task}: ` : ""}
              {e.message}
            </li>
          ))}
        </ul>
      )}
      {(plan.lint.fixes?.length ?? 0) > 0 && (
        <ul className="flex flex-col gap-1 font-mono text-xs text-info">
          {plan.lint.fixes?.map((f) => (
            <li key={`${f.task}-${f.message}`}>
              fixed · {f.task}: {f.message}
            </li>
          ))}
        </ul>
      )}

      <ol className="flex flex-col gap-2" aria-label="Planned tasks">
        {plan.graph.tasks.map((t) => (
          <li
            key={t.key}
            className="grid gap-2 rounded-md border border-line p-3 md:grid-cols-[minmax(0,1fr)_220px]"
            data-testid="planned-task"
          >
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-fg-muted">{t.key}</span>
                <Chip>{t.type}</Chip>
                {t.estimate && <Chip>{usd(t.estimate.usd)}</Chip>}
              </div>
              <p>{t.title}</p>
              <p className="text-xs text-fg-muted">{t.contract.objective}</p>
              <p className="font-mono text-2xs text-fg-subtle">
                {t.dependsOn.length ? `after ${t.dependsOn.join(", ")} · ` : ""}
                checks: {t.contract.acceptance.map((a) => a.kind).join(", ")}
                {t.contract.expectedFootprint?.paths.length
                  ? ` · files: ${t.contract.expectedFootprint.paths.join(", ")}`
                  : ""}
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${ids}-${t.key}`}>Agent</Label>
              <Select
                id={`${ids}-${t.key}`}
                value={t.pinnedAgentId ?? ""}
                disabled={busy !== null}
                onChange={(e) => void pin(t.key, e.target.value)}
              >
                <option value="">router decides</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.model}
                  </option>
                ))}
              </Select>
            </div>
          </li>
        ))}
      </ol>

      {plan.graph.assumptions.length > 0 && (
        <div className="text-xs text-fg-muted">
          <p className="font-mono text-2xs uppercase tracking-[0.08em]">Assumptions</p>
          <ul className="list-disc pl-5">
            {plan.graph.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {plan.graph.questions.length > 0 && (
          <div className="text-sm">
            <p className="font-mono text-2xs uppercase tracking-[0.08em] text-warning">The planner asks</p>
            <ul className="list-disc pl-5">
              {plan.graph.questions.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          </div>
        )}
        <Label htmlFor={`${ids}-notes`}>
          {plan.graph.questions.length ? "Your answers, or changes you want" : "Changes you want"}
        </Label>
        <Textarea
          id={`${ids}-notes`}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Use the existing auth library; skip the docs task."
        />
        <div>
          <Button
            disabled={busy !== null || !notes.trim()}
            onClick={() =>
              act("replan", async () => {
                await api(`/v1/missions/${missionId}/replan`, {
                  method: "POST",
                  body: { notes: [notes.trim()] },
                });
                setNotes("");
              })
            }
          >
            {busy === "replan" ? "Replanning…" : "Plan again with these notes"}
          </Button>
        </div>
      </div>
      <FormError>{error}</FormError>
    </section>
  );
}
