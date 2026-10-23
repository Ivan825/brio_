// Plan editor operations (BUILD_PLAN M3): every edit is a pure function from one plan graph to the next, so each saved
// edit is a new plan version and lint runs on the result.
import { PlanGraph, PlannedTask, TaskKey } from "@brio/schema";
import { z } from "zod";

export const PlanEdit = z.discriminatedUnion("op", [
  z.object({ op: z.literal("update"), key: TaskKey, patch: PlannedTask.partial().omit({ key: true }) }),
  z.object({ op: z.literal("add"), task: PlannedTask }),
  z.object({ op: z.literal("remove"), key: TaskKey }),
  /** Split one task into several; dependants of the original then wait for all parts. */
  z.object({ op: z.literal("split"), key: TaskKey, into: z.array(PlannedTask).min(2) }),
  /** Merge tasks into one, which inherits their dependencies and dependants. */
  z.object({ op: z.literal("merge"), keys: z.array(TaskKey).min(2), into: PlannedTask }),
  z.object({ op: z.literal("depend"), key: TaskKey, on: TaskKey }),
  z.object({ op: z.literal("undepend"), key: TaskKey, on: TaskKey }),
  z.object({
    op: z.literal("budget"),
    key: TaskKey,
    usd: z.number().nonnegative().optional(),
    minutes: z.number().positive().optional(),
  }),
  /** Assign a task to an agent (the router honours the pin), or clear it with null. */
  z.object({ op: z.literal("pin"), key: TaskKey, agentId: z.uuid().nullable() }),
  /** Require a person to accept this task's result (an approval gate). */
  z.object({ op: z.literal("gate"), key: TaskKey, on: z.boolean() }),
]);
export type PlanEdit = z.infer<typeof PlanEdit>;

export class PlanEditError extends Error {
  override name = "PlanEditError";
}

const find = (g: PlanGraph, key: string) => {
  const t = g.tasks.find((x) => x.key === key);
  if (!t) throw new PlanEditError(`no task ${key}`);
  return t;
};

const replaceDeps = (g: PlanGraph, from: string[], to: string[]) => {
  for (const t of g.tasks) {
    if (!t.dependsOn.some((d) => from.includes(d))) continue;
    t.dependsOn = [...new Set([...t.dependsOn.filter((d) => !from.includes(d)), ...to])].filter(
      (d) => d !== t.key,
    );
  }
};

export function applyPlanEdit(input: PlanGraph, edit: PlanEdit): PlanGraph {
  const g: PlanGraph = structuredClone(input);
  switch (edit.op) {
    case "update":
      Object.assign(find(g, edit.key), edit.patch);
      break;
    case "add":
      if (g.tasks.some((t) => t.key === edit.task.key))
        throw new PlanEditError(`task ${edit.task.key} already exists`);
      g.tasks.push(edit.task);
      break;
    case "remove": {
      const gone = find(g, edit.key);
      if (g.tasks.length === 1) throw new PlanEditError("a plan needs at least one task");
      g.tasks = g.tasks.filter((t) => t !== gone);
      // Dependants inherit the removed task's own dependencies, so the order around it survives.
      replaceDeps(g, [gone.key], gone.dependsOn);
      break;
    }
    case "split": {
      const orig = find(g, edit.key);
      const keys = edit.into.map((t) => t.key);
      if (keys.some((k) => k !== orig.key && g.tasks.some((t) => t.key === k)))
        throw new PlanEditError("split parts need new keys");
      const parts = edit.into.map((p, i) => ({
        ...p,
        dependsOn: [...new Set([...(i === 0 ? orig.dependsOn : []), ...p.dependsOn])],
      }));
      g.tasks.splice(g.tasks.indexOf(orig), 1, ...parts);
      replaceDeps(g, [orig.key], keys);
      break;
    }
    case "merge": {
      const parts = edit.keys.map((k) => find(g, k));
      const deps = [...new Set(parts.flatMap((p) => p.dependsOn))].filter((d) => !edit.keys.includes(d));
      const merged = { ...edit.into, dependsOn: [...new Set([...deps, ...edit.into.dependsOn])] };
      const at = g.tasks.indexOf(parts[0] as PlannedTask);
      g.tasks = g.tasks.filter((t) => !parts.includes(t));
      g.tasks.splice(Math.min(at, g.tasks.length), 0, merged);
      replaceDeps(g, edit.keys, [merged.key]);
      break;
    }
    case "depend":
      find(g, edit.on);
      if (edit.key === edit.on) throw new PlanEditError("a task cannot depend on itself");
      find(g, edit.key).dependsOn = [...new Set([...find(g, edit.key).dependsOn, edit.on])];
      break;
    case "undepend":
      find(g, edit.key).dependsOn = find(g, edit.key).dependsOn.filter((d) => d !== edit.on);
      break;
    case "budget": {
      const t = find(g, edit.key);
      t.contract.budget = {
        ...t.contract.budget,
        ...(edit.usd !== undefined ? { usd: edit.usd } : {}),
        ...(edit.minutes !== undefined ? { minutes: edit.minutes } : {}),
      };
      break;
    }
    case "pin": {
      const t = find(g, edit.key);
      if (edit.agentId) t.pinnedAgentId = edit.agentId;
      else delete t.pinnedAgentId;
      break;
    }
    case "gate": {
      const t = find(g, edit.key);
      const others = t.contract.acceptance.filter((a) => a.kind !== "human");
      t.contract.acceptance = edit.on
        ? [...others, { kind: "human", hard: true }]
        : others.length
          ? others
          : t.contract.acceptance;
      break;
    }
  }
  return PlanGraph.parse(g);
}
