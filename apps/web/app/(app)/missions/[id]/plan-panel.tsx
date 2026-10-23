"use client";

import { TASK_TYPES } from "@brio/schema";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Button } from "@/components/button";
import { Chip } from "@/components/chip";
import { FormError, Input, Label, Select, Textarea } from "@/components/field";
import { api } from "@/lib/api";
import { usd } from "@/lib/format";
import type { AgentSummary } from "@/lib/types";
import { PlanGraph } from "./plan-graph";

interface Acceptance {
  kind: string;
  hard: boolean;
  command?: string;
  [k: string]: unknown;
}

interface PlannedTask {
  key: string;
  type: string;
  title: string;
  dependsOn: string[];
  suggestedMode: string;
  pinnedAgentId?: string;
  estimate?: { usd: number; minutes: number };
  modeParams?: { n?: number; explicit?: boolean };
  contract: {
    objective: string;
    acceptance: Acceptance[];
    expectedFootprint?: { paths: string[] };
    budget?: { usd?: number; minutes?: number };
    [k: string]: unknown;
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

type Edit = Record<string, unknown> & { op: string };

const MODES = [
  ["single", "One agent"],
  ["best_of_n", "Best of N (parallel, pick the winner)"],
  ["ensemble", "Ensemble (merge several results)"],
  ["maker_checker", "Maker–checker"],
  ["debate", "Debate (two argue, a judge decides)"],
  ["cascade", "Cascade (cheap first, escalate)"],
] as const;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "task";

/**
 * The proposed plan, editable (PRD F3): list and graph views; reorder, split, merge, reassign, change mode, set a
 * task's budget, add approval gates, add and remove tasks and dependencies. Every edit is a new plan version, linted.
 */
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
  const [view, setView] = useState<"list" | "graph">("list");
  const [open, setOpen] = useState<string | null>(null);
  const [merging, setMerging] = useState<string[]>([]);
  const errors = plan.lint.errors ?? [];
  const tasks = plan.graph.tasks;

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
  const edit = (label: string, ...edits: Edit[]) =>
    act(label, () =>
      api(`/v1/missions/${missionId}/plans/${plan.version}/edits`, { method: "POST", body: { edits } }),
    );

  const fresh = (base: string) => {
    let k = slug(base);
    for (let i = 2; tasks.some((t) => t.key === k); i++) k = `${slug(base)}-${i}`;
    return k;
  };

  function merge() {
    const parts = tasks.filter((t) => merging.includes(t.key));
    const first = parts[0];
    if (!first) return;
    const into = {
      ...first,
      title: parts
        .map((p) => p.title)
        .join(" + ")
        .slice(0, 200),
      dependsOn: [],
      pinnedAgentId: undefined,
      contract: { ...first.contract, objective: parts.map((p) => p.contract.objective).join("\n") },
    };
    void edit("merge", { op: "merge", keys: merging, into }).then(() => setMerging([]));
  }

  return (
    <section
      aria-labelledby="plan-title"
      className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4"
      data-testid="plan-panel"
      data-version={plan.version}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 id="plan-title" className="font-medium">
            Plan v{plan.version}
          </h2>
          <Chip>
            {plan.origin === "user" ? "edited" : plan.origin === "template" ? "from a template" : "proposed"}
          </Chip>
          {plan.lint.estimate && (
            <Chip title="estimate">
              {usd(plan.lint.estimate.usd)} · {plan.lint.estimate.minutes} min
            </Chip>
          )}
        </div>
        <div className="flex items-center gap-2">
          <fieldset className="flex rounded-md border border-line" aria-label="Plan view">
            {(["list", "graph"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                className={`px-2.5 py-1 font-mono text-2xs ${view === v ? "bg-surface-2 text-fg" : "text-fg-muted"}`}
              >
                {v === "list" ? "List" : "Graph"}
              </button>
            ))}
          </fieldset>
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

      {view === "graph" && <PlanGraph tasks={tasks} selected={open} onSelect={(k) => setOpen(k)} />}

      <ol className="flex flex-col gap-2" aria-label="Planned tasks">
        {tasks.map((t, i) =>
          view === "graph" && open !== t.key ? null : (
            <li
              key={t.key}
              className="flex flex-col gap-2 rounded-md border border-line p-3"
              data-testid="planned-task"
              data-key={t.key}
            >
              <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_220px]">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="checkbox"
                      aria-label={`Select ${t.key} to merge`}
                      checked={merging.includes(t.key)}
                      onChange={() =>
                        setMerging(
                          merging.includes(t.key) ? merging.filter((k) => k !== t.key) : [...merging, t.key],
                        )
                      }
                    />
                    <span className="font-mono text-xs text-fg-muted">{t.key}</span>
                    <Chip>{t.type}</Chip>
                    {t.suggestedMode !== "single" && (
                      <Chip tone="info">{t.suggestedMode.replaceAll("_", " ")}</Chip>
                    )}
                    {t.contract.acceptance.some((a) => a.kind === "human") && (
                      <Chip tone="warning">approval gate</Chip>
                    )}
                    {t.estimate && <Chip>{usd(t.estimate.usd)}</Chip>}
                    {t.contract.budget?.usd !== undefined && <Chip>cap {usd(t.contract.budget.usd)}</Chip>}
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
                    onChange={(e) =>
                      void edit("pin", { op: "pin", key: t.key, agentId: e.target.value || null })
                    }
                  >
                    <option value="">router decides</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} · {a.model}
                      </option>
                    ))}
                  </Select>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Move ${t.key} up`}
                      disabled={busy !== null || i === 0}
                      onClick={() =>
                        void edit("move", { op: "move", key: t.key, before: tasks[i - 1]?.key ?? null })
                      }
                    >
                      ↑
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Move ${t.key} down`}
                      disabled={busy !== null || i === tasks.length - 1}
                      onClick={() =>
                        void edit("move", { op: "move", key: t.key, before: tasks[i + 2]?.key ?? null })
                      }
                    >
                      ↓
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-expanded={open === t.key && view === "list"}
                      onClick={() => setOpen(open === t.key && view === "list" ? null : t.key)}
                    >
                      Edit
                    </Button>
                  </div>
                </div>
              </div>
              {open === t.key && (
                <TaskEditor
                  task={t}
                  others={tasks.filter((x) => x.key !== t.key)}
                  busy={busy !== null}
                  onEdit={(label, ...e) => edit(label, ...e)}
                  fresh={fresh}
                  canRemove={tasks.length > 1}
                />
              )}
            </li>
          ),
        )}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        {merging.length >= 2 && (
          <Button disabled={busy !== null} onClick={merge}>
            Merge {merging.length} selected tasks
          </Button>
        )}
        <AddTask busy={busy !== null} fresh={fresh} onAdd={(task) => void edit("add", { op: "add", task })} />
      </div>

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

/** One task's settings: words, mode, budget, approval gate, dependencies; split it or remove it. */
function TaskEditor({
  task: t,
  others,
  busy,
  onEdit,
  fresh,
  canRemove,
}: {
  task: PlannedTask;
  others: PlannedTask[];
  busy: boolean;
  onEdit: (label: string, ...edits: Edit[]) => Promise<void>;
  fresh: (base: string) => string;
  canRemove: boolean;
}) {
  const id = useId();
  const [title, setTitle] = useState(t.title);
  const [objective, setObjective] = useState(t.contract.objective);
  const [mode, setMode] = useState(t.suggestedMode === "pipeline" ? "single" : t.suggestedMode);
  const [n, setN] = useState(String(t.modeParams?.n ?? 3));
  const [budgetUsd, setBudgetUsd] = useState(t.contract.budget?.usd?.toString() ?? "");
  const [budgetMin, setBudgetMin] = useState(t.contract.budget?.minutes?.toString() ?? "");
  const [splitA, setSplitA] = useState("");
  const [splitB, setSplitB] = useState("");
  const gated = t.contract.acceptance.some((a) => a.kind === "human");

  const words =
    title !== t.title || objective !== t.contract.objective
      ? [{ op: "update", key: t.key, patch: { title, contract: { ...t.contract, objective } } }]
      : [];
  const modeEdit =
    mode !== t.suggestedMode || (mode === "best_of_n" && Number(n) !== (t.modeParams?.n ?? 3))
      ? [{ op: "mode", key: t.key, mode, ...(mode === "best_of_n" ? { n: Number(n) } : {}) }]
      : [];
  const budget =
    budgetUsd !== (t.contract.budget?.usd?.toString() ?? "") ||
    budgetMin !== (t.contract.budget?.minutes?.toString() ?? "")
      ? [
          {
            op: "budget",
            key: t.key,
            ...(budgetUsd ? { usd: Number(budgetUsd) } : {}),
            ...(budgetMin ? { minutes: Number(budgetMin) } : {}),
          },
        ]
      : [];
  const changes = [...words, ...modeEdit, ...budget];

  function split() {
    const a = fresh(`${t.key}-1`);
    const b = fresh(`${t.key}-2`) === a ? `${a}-b` : fresh(`${t.key}-2`);
    const part = (key: string, title: string, dependsOn: string[]) => ({
      ...t,
      key,
      title,
      dependsOn,
      pinnedAgentId: undefined,
      contract: { ...t.contract, objective: title },
    });
    void onEdit("split", {
      op: "split",
      key: t.key,
      into: [part(a, splitA, t.dependsOn), part(b, splitB, [a])],
    });
  }

  return (
    <div className="flex flex-col gap-3 border-t border-line pt-3" data-testid="task-editor">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-title`}>Title</Label>
          <Input
            id={`${id}-title`}
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-mode`}>Mode</Label>
          <div className="flex gap-2">
            <Select id={`${id}-mode`} value={mode} onChange={(e) => setMode(e.target.value)}>
              {MODES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
            {mode === "best_of_n" && (
              <Input
                aria-label="N"
                type="number"
                min={2}
                max={5}
                value={n}
                onChange={(e) => setN(e.target.value)}
                className="w-16"
              />
            )}
          </div>
        </div>
        <div className="flex flex-col gap-1 md:col-span-2">
          <Label htmlFor={`${id}-objective`}>Objective</Label>
          <Textarea
            id={`${id}-objective`}
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            className="min-h-16"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-usd`}>Budget cap (USD)</Label>
          <Input
            id={`${id}-usd`}
            type="number"
            min={0}
            step="0.1"
            value={budgetUsd}
            onChange={(e) => setBudgetUsd(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-min`}>Time cap (minutes)</Label>
          <Input
            id={`${id}-min`}
            type="number"
            min={1}
            value={budgetMin}
            onChange={(e) => setBudgetMin(e.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={gated}
            disabled={busy}
            onChange={(e) => void onEdit("gate", { op: "gate", key: t.key, on: e.target.checked })}
          />
          A person approves the result
        </label>
      </div>
      {others.length > 0 && (
        <fieldset className="flex flex-col gap-1">
          <legend className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">Runs after</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {others.map((o) => (
              <label key={o.key} className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={t.dependsOn.includes(o.key)}
                  disabled={busy}
                  onChange={(e) =>
                    void onEdit("depend", {
                      op: e.target.checked ? "depend" : "undepend",
                      key: t.key,
                      on: o.key,
                    })
                  }
                />
                <span className="font-mono">{o.key}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={busy || !changes.length}
          onClick={() => void onEdit("save", ...changes)}
        >
          Save changes
        </Button>
        {canRemove && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void onEdit("remove", { op: "remove", key: t.key })}
          >
            Remove task
          </Button>
        )}
        <span className="ml-auto flex items-center gap-1">
          <Input
            aria-label="First part"
            placeholder="First part"
            value={splitA}
            onChange={(e) => setSplitA(e.target.value)}
            className="w-36"
          />
          <Input
            aria-label="Second part"
            placeholder="Second part"
            value={splitB}
            onChange={(e) => setSplitB(e.target.value)}
            className="w-36"
          />
          <Button size="sm" disabled={busy || !splitA.trim() || !splitB.trim()} onClick={split}>
            Split
          </Button>
        </span>
      </div>
    </div>
  );
}

/** A new task: title, type and objective; a reviewer from another vendor checks it against the objective. */
function AddTask({
  busy,
  fresh,
  onAdd,
}: {
  busy: boolean;
  fresh: (base: string) => string;
  onAdd: (task: PlannedTask & Record<string, unknown>) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [type, setType] = useState<string>("write.doc");
  const [objective, setObjective] = useState("");
  if (!open)
    return (
      <Button variant="ghost" onClick={() => setOpen(true)}>
        Add a task
      </Button>
    );
  return (
    <fieldset
      className="flex w-full flex-col gap-2 rounded-md border border-line p-3"
      aria-label="Add a task"
    >
      <div className="grid gap-2 md:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-t`}>New task</Label>
          <Input id={`${id}-t`} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-type`}>Type</Label>
          <Select id={`${id}-type`} value={type} onChange={(e) => setType(e.target.value)}>
            {TASK_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1 md:col-span-2">
          <Label htmlFor={`${id}-o`}>What it must achieve</Label>
          <Textarea
            id={`${id}-o`}
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            className="min-h-16"
          />
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={busy || !title.trim() || !objective.trim()}
          onClick={() => {
            onAdd({
              key: fresh(title),
              type,
              title,
              dependsOn: [],
              suggestedMode: "single",
              contract: {
                objective,
                inputs: [],
                outputs: [{ kind: "report", description: title }],
                acceptance: [{ kind: "rubric_review", hard: true, criteria: [objective.slice(0, 300)] }],
                constraints: [],
                sensitivity: "internal",
              },
            });
            setOpen(false);
            setTitle("");
            setObjective("");
          }}
        >
          Add
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </fieldset>
  );
}
