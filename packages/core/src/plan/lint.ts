// Plan lint (ROUTING_AND_QUALITY §2 step 5), pure. Errors block approval; fixes are applied automatically and listed
// so the user sees exactly what changed: contract consumers get an edge to the contract's producer, and parallel code
// tasks with overlapping footprints are serialised (the planner's lease inference, step 3).
import type { PlanGraph, PlannedTask } from "@brio/schema";
import { footprintsOverlap } from "../leases/overlap";

export interface LintIssue {
  task?: string;
  message: string;
}

export interface LintResult {
  graph: PlanGraph;
  errors: LintIssue[];
  warnings: LintIssue[];
  fixes: LintIssue[];
  estimate: { usd: number; minutes: number } | null;
}

/** Keys of everything `key` depends on, directly or not. */
export function ancestors(graph: PlanGraph, key: string): Set<string> {
  const byKey = new Map(graph.tasks.map((t) => [t.key, t]));
  const seen = new Set<string>();
  const stack = [...(byKey.get(key)?.dependsOn ?? [])];
  while (stack.length) {
    const k = stack.pop() as string;
    if (seen.has(k)) continue;
    seen.add(k);
    stack.push(...(byKey.get(k)?.dependsOn ?? []));
  }
  return seen;
}

/** A cycle as a list of keys, or null. */
export function findCycle(graph: PlanGraph): string[] | null {
  const deps = new Map(graph.tasks.map((t) => [t.key, t.dependsOn]));
  const state = new Map<string, 1 | 2>();
  const path: string[] = [];
  const visit = (k: string): string[] | null => {
    if (state.get(k) === 2) return null;
    if (state.get(k) === 1) return [...path.slice(path.indexOf(k)), k];
    state.set(k, 1);
    path.push(k);
    for (const d of deps.get(k) ?? []) {
      if (!deps.has(d)) continue;
      const c = visit(d);
      if (c) return c;
    }
    path.pop();
    state.set(k, 2);
    return null;
  };
  for (const k of deps.keys()) {
    const c = visit(k);
    if (c) return c;
  }
  return null;
}

const isCode = (t: PlannedTask) => t.type.startsWith("code.") || t.type === "merge.integrate";

export function lintPlan(input: PlanGraph, opts: { budgetUsd?: number; maxTasks?: number } = {}): LintResult {
  const graph: PlanGraph = structuredClone(input);
  const errors: LintIssue[] = [];
  const warnings: LintIssue[] = [];
  const fixes: LintIssue[] = [];
  const keys = new Set<string>();

  for (const t of graph.tasks) {
    if (keys.has(t.key)) errors.push({ task: t.key, message: "duplicate task key" });
    keys.add(t.key);
  }
  if (graph.tasks.length > (opts.maxTasks ?? 40))
    errors.push({ message: `a plan has at most ${opts.maxTasks ?? 40} tasks; split the mission` });

  for (const t of graph.tasks) {
    t.dependsOn = [...new Set(t.dependsOn)];
    for (const d of t.dependsOn) {
      if (d === t.key) errors.push({ task: t.key, message: "a task cannot depend on itself" });
      else if (!keys.has(d)) errors.push({ task: t.key, message: `depends on unknown task ${d}` });
    }
    if (t.contract.acceptance.length === 0) errors.push({ task: t.key, message: "no acceptance checks" });
    for (const a of t.contract.acceptance)
      if (["tests", "typecheck", "lint", "build"].includes(a.kind) && !a.command?.trim())
        errors.push({ task: t.key, message: `the ${a.kind} check needs a command` });
    if (isCode(t) && !t.contract.expectedFootprint?.paths.length)
      warnings.push({
        task: t.key,
        message: "code task without an expected footprint: it cannot run beside other code tasks",
      });
  }

  // Contract-first: whoever consumes a contract waits for the task that defines it.
  for (const t of graph.tasks) {
    for (const input of t.contract.inputs) {
      if (input.kind !== "contract") continue;
      const producer = graph.tasks.find((p) => p.key === input.ref);
      if (!producer) {
        errors.push({ task: t.key, message: `uses contract ${input.ref}, which no task defines` });
        continue;
      }
      if (!producer.type.startsWith("design."))
        warnings.push({ task: producer.key, message: "defines a contract but is not a design task" });
      if (producer.key !== t.key && !ancestors(graph, t.key).has(producer.key)) {
        t.dependsOn.push(producer.key);
        fixes.push({
          task: t.key,
          message: `now waits for ${producer.key}, which defines the contract it uses`,
        });
      }
    }
  }

  const cycle = findCycle(graph);
  if (cycle) errors.push({ message: `dependency cycle: ${cycle.join(" → ")}` });

  // Parallel code tasks that may touch the same files are serialised in plan order.
  if (!cycle) {
    const code = graph.tasks.filter(isCode);
    for (let i = 0; i < code.length; i++)
      for (let j = i + 1; j < code.length; j++) {
        const a = code[i] as PlannedTask;
        const b = code[j] as PlannedTask;
        if (ancestors(graph, a.key).has(b.key) || ancestors(graph, b.key).has(a.key)) continue;
        const fa = a.contract.expectedFootprint?.paths ?? [];
        const fb = b.contract.expectedFootprint?.paths ?? [];
        if (fa.length && fb.length && !footprintsOverlap(fa, fb)) continue;
        b.dependsOn.push(a.key);
        fixes.push({
          task: b.key,
          message:
            fa.length && fb.length
              ? `now runs after ${a.key}: both may change the same files`
              : `now runs after ${a.key}: one has no declared footprint`,
        });
      }
  }

  // Every task must lead somewhere: a leaf with nothing to hand over contributes nothing.
  const hasDependants = new Set(graph.tasks.flatMap((t) => t.dependsOn));
  for (const t of graph.tasks)
    if (!hasDependants.has(t.key) && t.contract.outputs.length === 0)
      errors.push({ task: t.key, message: "a final task with no outputs does not contribute to the goal" });

  const estimated = graph.tasks.filter((t) => t.estimate);
  const estimate = estimated.length
    ? {
        usd: Math.round(estimated.reduce((s, t) => s + (t.estimate?.usd ?? 0), 0) * 1e6) / 1e6,
        minutes: criticalPathMinutes(graph),
      }
    : null;
  if (estimate && opts.budgetUsd !== undefined && estimate.usd > opts.budgetUsd)
    warnings.push({ message: `estimated $${estimate.usd} is over the mission budget of $${opts.budgetUsd}` });
  if (graph.questions.length > 3) errors.push({ message: "at most 3 clarifying questions" });

  return { graph, errors, warnings, fixes, estimate };
}

/** Wall-clock minutes along the longest dependency chain (tasks without an estimate count as 0). */
export function criticalPathMinutes(graph: PlanGraph): number {
  const byKey = new Map(graph.tasks.map((t) => [t.key, t]));
  const memo = new Map<string, number>();
  const finish = (k: string, depth = 0): number => {
    if (memo.has(k)) return memo.get(k) as number;
    const t = byKey.get(k);
    if (!t || depth > graph.tasks.length) return 0;
    const v = (t.estimate?.minutes ?? 0) + Math.max(0, ...t.dependsOn.map((d) => finish(d, depth + 1)));
    memo.set(k, v);
    return v;
  };
  return Math.max(0, ...graph.tasks.map((t) => finish(t.key)));
}
