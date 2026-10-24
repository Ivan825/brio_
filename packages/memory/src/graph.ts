// The project memory graph (PRD F31–F32, BUILD_PLAN M9): what a project's missions decided and did, kept across
// missions. Ingested from the event log — tasks and their contracts, the prompt each agent was given, the files each
// change touched, the agents who made them, and the decisions behind them (the plan's assumptions, people's answers to
// agents, reviewers' verdicts). A brief for files walks from each file to the changes that touched it and gathers their
// decisions, contracts and prompts; a brief for a topic matches text. Retrieval is by graph and text (embeddings are
// not computed yet: the column waits for an embedding connector).
import { type DbOrTx, schema } from "@brio/db";
import type { Event, TaskContract } from "@brio/schema";
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";

const { artifacts, attempts, agents, memoryEdges, memoryNodes, messages, missions, plans, tasks } = schema;

export type NodeKind = (typeof memoryNodes.$inferSelect)["kind"];
export type EdgeKind = (typeof memoryEdges.$inferSelect)["kind"];

export interface BriefItem {
  kind: NodeKind;
  title: string;
  body: string;
  /** Why it is in the brief: the file or topic it came from. */
  via?: string;
}

export interface Brief {
  summary: string;
  items: BriefItem[];
}

const MAX_BODY = 4000;
const clip = (s: string, n = MAX_BODY) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** The node standing for `ref` in the project, created or updated. */
export async function upsertNode(
  db: DbOrTx,
  n: {
    workspaceId: string;
    projectId: string;
    kind: NodeKind;
    ref: string | null;
    title: string;
    body: string;
    sourceEventId?: string | null;
  },
): Promise<string> {
  const values = {
    workspaceId: n.workspaceId,
    projectId: n.projectId,
    kind: n.kind,
    ref: n.ref,
    title: clip(n.title, 300),
    body: clip(n.body),
    sourceEventId: n.sourceEventId ?? null,
  };
  if (!n.ref) {
    const [row] = await db.insert(memoryNodes).values(values).returning({ id: memoryNodes.id });
    return (row as { id: string }).id;
  }
  const [row] = await db
    .insert(memoryNodes)
    .values(values)
    .onConflictDoUpdate({
      target: [memoryNodes.projectId, memoryNodes.ref],
      targetWhere: sql`${memoryNodes.ref} is not null`,
      set: { title: values.title, body: values.body, updatedAt: new Date() },
    })
    .returning({ id: memoryNodes.id });
  return (row as { id: string }).id;
}

export async function link(db: DbOrTx, workspaceId: string, fromId: string, toId: string, kind: EdgeKind) {
  if (fromId === toId) return;
  await db.insert(memoryEdges).values({ workspaceId, fromId, toId, kind }).onConflictDoNothing();
}

const contractBody = (c: TaskContract) =>
  [
    c.objective,
    c.outputs.length
      ? `Outputs: ${c.outputs.map((o) => `${o.kind}${o.path ? ` ${o.path}` : ""} — ${o.description}`).join("; ")}`
      : "",
    c.acceptance.length
      ? `Accepted when: ${c.acceptance.map((a) => `${a.kind}${a.command ? ` (${a.command})` : ""}${a.hard ? "" : " (soft)"}`).join("; ")}`
      : "",
    c.constraints.length ? `Constraints: ${c.constraints.join("; ")}` : "",
    c.expectedFootprint?.paths.length ? `Files: ${c.expectedFootprint.paths.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

/** Ingests one event into its project's graph; events of project-less missions are not remembered. */
export async function ingestEvent(db: DbOrTx, e: Event): Promise<void> {
  const [m] = await db.select().from(missions).where(eq(missions.id, e.missionId));
  if (!m?.projectId) return;
  const base = { workspaceId: m.workspaceId, projectId: m.projectId, sourceEventId: e.id };
  const p = e.payload as Record<string, unknown>;
  const taskNode = async (taskId: string) => {
    const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    if (!t) return null;
    const id = await upsertNode(db, {
      ...base,
      kind: "task",
      ref: `task:${t.id}`,
      title: `${t.title} (${t.key})`,
      body: `Mission: ${m.title}\nType: ${t.type}\n${contractBody(t.contract as TaskContract)}`,
    });
    return { id, task: t };
  };

  switch (e.type) {
    case "plan.approved": {
      // The plan's assumptions are decisions behind every task it set.
      const [plan] = await db
        .select()
        .from(plans)
        .where(and(eq(plans.missionId, m.id), eq(plans.status, "approved")))
        .orderBy(desc(plans.version))
        .limit(1);
      if (!plan) return;
      const rows = await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.missionId, m.id), eq(tasks.planVersion, plan.version)));
      const nodes: string[] = [];
      for (const t of rows) {
        const n = await taskNode(t.id);
        if (n) nodes.push(n.id);
      }
      for (const a of plan.graph.assumptions) {
        const d = await upsertNode(db, {
          ...base,
          kind: "decision",
          ref: `assumption:${m.id}:${a.slice(0, 120)}`,
          title: `Assumed: ${a}`,
          body: `In mission "${m.title}" (plan v${plan.version}).`,
        });
        for (const n of nodes) await link(db, m.workspaceId, d, n, "decided_in");
      }
      return;
    }
    case "message.answered": {
      // A person's answer to an agent's question: a decision for that agent's task.
      const [q] = await db
        .select()
        .from(messages)
        .where(eq(messages.id, String(p.questionId ?? "")));
      if (!q) return;
      const [asker] = q.fromAttemptId
        ? await db.select({ taskId: attempts.taskId }).from(attempts).where(eq(attempts.id, q.fromAttemptId))
        : [];
      const d = await upsertNode(db, {
        ...base,
        kind: "decision",
        ref: `answer:${q.id}`,
        title: `Answered: ${clip(q.body, 200)}`,
        body: `Q: ${q.body}\nA: ${String(p.body ?? "")}`,
      });
      const taskId = asker?.taskId ?? q.toTaskId;
      if (taskId) {
        const n = await taskNode(taskId);
        if (n) await link(db, m.workspaceId, d, n.id, "decided_in");
      }
      return;
    }
    case "review.verdict": {
      const reasons = (p.reasons as string[] | undefined) ?? [];
      if (!e.taskId || !reasons.length) return;
      const n = await taskNode(e.taskId);
      if (!n) return;
      const d = await upsertNode(db, {
        ...base,
        kind: "decision",
        ref: `verdict:${e.id}`,
        title: `Review ${String(p.verdict)}: ${clip(reasons[0] ?? "", 160)}`,
        body: reasons.join("\n"),
      });
      await link(db, m.workspaceId, d, n.id, "decided_in");
      return;
    }
    case "task.done": {
      if (!e.taskId) return;
      const n = await taskNode(e.taskId);
      if (!n) return;
      const contract = n.task.contract as TaskContract;
      // The task's own contract, and the shared contracts it was built against.
      const c = await upsertNode(db, {
        ...base,
        kind: "contract",
        ref: `contract:task:${n.task.id}`,
        title: `Contract of ${n.task.title}`,
        body: contractBody(contract),
      });
      await link(db, m.workspaceId, n.id, c, "implements");
      for (const input of contract.inputs.filter((i) => i.kind === "contract")) {
        const [shared] = await db
          .select()
          .from(schema.contracts)
          .where(and(eq(schema.contracts.missionId, m.id), eq(schema.contracts.name, input.ref)))
          .orderBy(desc(schema.contracts.createdAt))
          .limit(1);
        if (!shared) continue;
        const s = await upsertNode(db, {
          ...base,
          kind: "contract",
          ref: `contract:${shared.name}@${shared.version}`,
          title: `${shared.name} v${shared.version}`,
          body: typeof shared.spec === "string" ? shared.spec : JSON.stringify(shared.spec, null, 2),
        });
        await link(db, m.workspaceId, n.id, s, "depends_on");
      }
      // Who made it, what they were told, and the files they changed.
      const attemptId = String(p.attemptId ?? "");
      const [a] = attemptId ? await db.select().from(attempts).where(eq(attempts.id, attemptId)) : [];
      if (!a) return;
      const [agent] = await db.select().from(agents).where(eq(agents.id, a.agentId));
      if (agent) {
        const ag = await upsertNode(db, {
          ...base,
          kind: "agent",
          ref: `agent:${agent.id}`,
          title: `${agent.name} (${agent.model})`,
          body: agent.rolePrompt,
        });
        await link(db, m.workspaceId, ag, n.id, "implements");
      }
      const instructions =
        (a.dispatch as { input?: { instructions?: string } } | null)?.input?.instructions ?? "";
      const prompt = instructions
        ? await upsertNode(db, {
            ...base,
            kind: "prompt",
            ref: `prompt:${a.id}`,
            title: `Prompt for ${n.task.title}`,
            body: instructions,
          })
        : null;
      if (prompt) await link(db, m.workspaceId, n.id, prompt, "prompted_by");
      const [diff] = await db
        .select({ meta: artifacts.meta })
        .from(artifacts)
        .where(and(eq(artifacts.attemptId, a.id), eq(artifacts.kind, "diff")));
      const files = (
        (diff?.meta as { files?: Array<{ path: string; status: string }> } | undefined)?.files ?? []
      ).slice(0, 200);
      for (const f of files) {
        const fileNode = await upsertNode(db, {
          ...base,
          kind: "file",
          ref: `file:${f.path}`,
          title: f.path,
          body: `Last ${f.status} by "${n.task.title}" in mission "${m.title}".`,
        });
        await link(db, m.workspaceId, n.id, fileNode, "touches");
        if (prompt) await link(db, m.workspaceId, fileNode, prompt, "prompted_by");
      }
      return;
    }
  }
}

/** Event types that teach the graph something. */
export const MEMORY_EVENTS = new Set(["plan.approved", "message.answered", "review.verdict", "task.done"]);

/** A footprint path or glob as a LIKE pattern on file node titles. */
const likeOf = (path: string) =>
  path
    .replace(/[%_]/g, (c) => `\\${c}`)
    .replace(/\*\*\/?/g, "%")
    .replace(/\*/g, "%");

/**
 * The brief an agent (or a person) gets: for files, the changes that touched each one with their decisions, contracts
 * and prompts, newest first; for a topic, the nodes whose words match; always the project's preferences.
 */
export async function brief(
  db: DbOrTx,
  projectId: string,
  q: { paths?: string[]; topic?: string; limit?: number },
): Promise<Brief> {
  const limit = q.limit ?? 30;
  const items: BriefItem[] = [];
  const seen = new Set<string>();
  const add = (n: typeof memoryNodes.$inferSelect, via?: string) => {
    if (seen.has(n.id) || items.length >= limit) return;
    seen.add(n.id);
    items.push({ kind: n.kind, title: n.title, body: n.body, ...(via ? { via } : {}) });
  };
  const neighbours = async (ids: string[], kinds: EdgeKind[], dir: "from" | "to") => {
    if (!ids.length) return [];
    const rows = await db
      .select({ n: memoryNodes })
      .from(memoryEdges)
      .innerJoin(memoryNodes, eq(memoryNodes.id, dir === "from" ? memoryEdges.toId : memoryEdges.fromId))
      .where(
        and(
          inArray(dir === "from" ? memoryEdges.fromId : memoryEdges.toId, ids),
          inArray(memoryEdges.kind, kinds),
        ),
      )
      .orderBy(desc(memoryNodes.updatedAt));
    return rows.map((r) => r.n);
  };

  for (const n of await db
    .select()
    .from(memoryNodes)
    .where(and(eq(memoryNodes.projectId, projectId), eq(memoryNodes.kind, "preference")))
    .orderBy(desc(memoryNodes.updatedAt))
    .limit(10))
    add(n);

  for (const path of q.paths ?? []) {
    const files = await db
      .select()
      .from(memoryNodes)
      .where(
        and(
          eq(memoryNodes.projectId, projectId),
          eq(memoryNodes.kind, "file"),
          path.includes("*") ? sql`${memoryNodes.title} like ${likeOf(path)}` : eq(memoryNodes.title, path),
        ),
      )
      .limit(20);
    for (const f of files) {
      // The tasks that changed it, newest first; then what was decided for them, their contracts and prompts.
      const changed = (await neighbours([f.id], ["touches"], "to")).slice(0, 5);
      const prompts = await neighbours([f.id], ["prompted_by"], "from");
      const decisions = await neighbours(
        changed.map((t) => t.id),
        ["decided_in"],
        "to",
      );
      const contracts = await neighbours(
        changed.map((t) => t.id),
        ["implements", "depends_on"],
        "from",
      );
      for (const d of decisions) add(d, f.title);
      for (const c of contracts.filter((x) => x.kind === "contract")) add(c, f.title);
      for (const t of changed) add(t, f.title);
      for (const p of prompts.slice(0, 3)) add(p, f.title);
    }
  }

  if (q.topic?.trim()) {
    const words = q.topic
      .split(/\s+/)
      .map((w) => w.replace(/[^\p{L}\p{N}_.-]/gu, ""))
      .filter((w) => w.length > 2)
      .slice(0, 6);
    if (words.length)
      for (const n of await db
        .select()
        .from(memoryNodes)
        .where(
          and(
            eq(memoryNodes.projectId, projectId),
            inArray(memoryNodes.kind, ["decision", "contract", "fact", "task", "preference"]),
            or(
              ...words.flatMap((w) => [
                ilike(memoryNodes.title, `%${w}%`),
                ilike(memoryNodes.body, `%${w}%`),
              ]),
            ),
          ),
        )
        .orderBy(desc(memoryNodes.updatedAt))
        .limit(10))
        add(n, q.topic);
  }

  return { summary: renderBrief(items), items };
}

const KIND_TITLE: Record<NodeKind, string> = {
  preference: "Preferences",
  decision: "Decisions",
  contract: "Contracts",
  task: "Recent changes",
  prompt: "Prompts behind them",
  file: "Files",
  fact: "Facts",
  agent: "Agents",
};

/** The brief as Markdown, by kind, for an agent's prompt and .brio/brief.md. */
export function renderBrief(items: BriefItem[]): string {
  if (!items.length) return "";
  const groups = new Map<NodeKind, BriefItem[]>();
  for (const i of items) groups.set(i.kind, [...(groups.get(i.kind) ?? []), i]);
  const order: NodeKind[] = ["preference", "decision", "contract", "task", "prompt", "fact", "file", "agent"];
  return order
    .filter((k) => groups.has(k))
    .map(
      (k) =>
        `### ${KIND_TITLE[k]}\n${(groups.get(k) ?? [])
          .map(
            (i) =>
              `- **${i.title}**${i.via ? ` _(${i.via})_` : ""}${i.body ? `\n  ${clip(i.body, k === "prompt" ? 600 : 1200).replaceAll("\n", "\n  ")}` : ""}`,
          )
          .join("\n")}`,
    )
    .join("\n\n");
}
