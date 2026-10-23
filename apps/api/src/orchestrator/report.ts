// The mission report from the database (BUILD_PLAN M5): gathered live for the board, and snapshotted with a Markdown
// artifact when a mission ends.
import { createHash } from "node:crypto";
import type { AttemptChecks } from "@brio/adapters";
import {
  buildMissionReport,
  type MissionReport,
  type ReportAttempt,
  type ReportTask,
  renderMissionReport,
} from "@brio/core";
import { type DbOrTx, schema } from "@brio/db";
import { and, desc, eq, inArray } from "drizzle-orm";

const { artifacts, attempts, blobs, integrations, messages, missions, plans, tasks } = schema;

type AttemptRow = typeof attempts.$inferSelect;

const agentOf = (a: AttemptRow) =>
  (a.dispatch as { agent?: { name?: string; connector?: { presetKey?: string } } } | null)?.agent;
const purposeOf = (a: AttemptRow) =>
  (a.dispatch as { mode?: { purpose?: string } } | null)?.mode?.purpose ?? "make";
const seconds = (a: AttemptRow) =>
  a.startedAt && a.endedAt ? Math.max(0, (a.endedAt.getTime() - a.startedAt.getTime()) / 1000) : 0;

export async function missionReport(db: DbOrTx, missionId: string): Promise<MissionReport | null> {
  const [m] = await db.select().from(missions).where(eq(missions.id, missionId));
  if (!m) return null;
  const [plan] = await db
    .select()
    .from(plans)
    .where(and(eq(plans.missionId, m.id), eq(plans.status, "approved")))
    .orderBy(desc(plans.version))
    .limit(1);
  const all = await db.select().from(tasks).where(eq(tasks.missionId, m.id));
  // In plan order (ids are time-ordered, so tasks inserted together keep their order).
  const shown = all
    .filter((t) => (plan ? t.planVersion === plan.version : t.planVersion > 0))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const taskIds = all.map((t) => t.id);
  const tried = taskIds.length
    ? await db.select().from(attempts).where(inArray(attempts.taskId, taskIds))
    : [];

  const rows: ReportTask[] = [];
  for (const t of shown) {
    const p = t.modeParams as {
      route?: { mode: string; rationale: string };
      result?: { attemptId: string; note: string };
      reroutes?: number;
      carriedFrom?: string;
    };
    const own = tried.filter((a) => a.taskId === t.id);
    const made = own
      .filter((a) => a.status === "succeeded" && ["make", "revise", "merge"].includes(purposeOf(a)))
      .sort((a, b) => (b.endedAt?.getTime() ?? 0) - (a.endedAt?.getTime() ?? 0));
    const result = p.result ? (tried.find((a) => a.id === p.result?.attemptId) ?? null) : (made[0] ?? null);
    const checks = ((result?.checks as AttemptChecks | null)?.items ?? []).map((c) => ({
      kind: c.kind,
      hard: c.hard,
      status: c.status,
      ...(c.summary ? { summary: c.summary } : {}),
    }));
    rows.push({
      key: t.key,
      title: t.title,
      type: t.type,
      status: t.status,
      agent: result ? (agentOf(result)?.name ?? null) : null,
      vendor: result ? (agentOf(result)?.connector?.presetKey ?? null) : null,
      mode: p.carriedFrom ? "carried" : (p.route?.mode ?? t.mode),
      rationale: p.route?.rationale ?? null,
      note: p.result?.note ?? null,
      revisions: t.revisions,
      reroutes: p.reroutes ?? 0,
      carried: Boolean(p.carriedFrom),
      costUsd: own.reduce((s, a) => s + (a.costUsd ?? 0), 0),
      seconds: own.reduce((s, a) => s + seconds(a), 0),
      checks,
      blockedReason: t.blockedReason,
    });
  }
  const spent: ReportAttempt[] = tried
    .filter((a) => a.status !== "queued")
    .map((a) => ({
      agent: agentOf(a)?.name ?? "agent",
      vendor: agentOf(a)?.connector?.presetKey ?? "unknown",
      costUsd: a.costUsd ?? 0,
      seconds: seconds(a),
      scored: a.scored,
      role: a.role,
    }));
  const [integration] = await db
    .select()
    .from(integrations)
    .where(eq(integrations.missionId, m.id))
    .orderBy(desc(integrations.createdAt))
    .limit(1);
  const open = await db
    .select({ body: messages.body })
    .from(messages)
    .where(
      and(
        eq(messages.missionId, m.id),
        eq(messages.toUser, true),
        eq(messages.kind, "question"),
        eq(messages.status, "open"),
      ),
    );
  const report = (m.report ?? {}) as { replans?: number };
  const terminal = m.status === "done" || m.status === "failed" || m.status === "cancelled";
  return buildMissionReport({
    mission: {
      title: m.title,
      goal: m.goal,
      status: m.status,
      ...(m.budget.usd !== undefined ? { budgetUsd: m.budget.usd } : {}),
      createdAt: m.createdAt,
      endedAt: terminal ? m.updatedAt : null,
    },
    tasks: rows,
    attempts: spent,
    integration: integration
      ? {
          status: integration.status,
          branch: integration.branch,
          commit: integration.commit,
          round: integration.round,
          conflicts: integration.conflicts,
          checks: integration.checks.map((c) => ({ command: c.command, passed: c.passed })),
        }
      : null,
    assumptions: plan?.graph.assumptions ?? [],
    unanswered: open.map((q) => q.body),
    replans: report.replans ?? 0,
  });
}

/** Snapshots the final report on the mission (report.final) and as a Markdown artifact, in the caller's transaction. */
export async function saveMissionReport(db: DbOrTx, missionId: string): Promise<MissionReport | null> {
  const report = await missionReport(db, missionId);
  if (!report) return null;
  const [m] = await db.select().from(missions).where(eq(missions.id, missionId));
  if (!m) return null;
  const md = Buffer.from(renderMissionReport(report), "utf8");
  const sha256 = createHash("sha256").update(md).digest("hex");
  await db
    .insert(blobs)
    .values({
      workspaceId: m.workspaceId,
      sha256,
      contentType: "text/markdown; charset=utf-8",
      size: md.length,
      bytes: md,
    })
    .onConflictDoNothing();
  const [artifact] = await db
    .insert(artifacts)
    .values({
      workspaceId: m.workspaceId,
      kind: "report",
      storageRef: `blob:${sha256}`,
      sha256,
      meta: { missionId, missionReport: true, status: report.status },
    })
    .returning({ id: artifacts.id });
  await db
    .update(missions)
    .set({ report: { ...(m.report ?? {}), final: report, reportArtifactId: artifact?.id ?? null } })
    .where(eq(missions.id, missionId));
  return report;
}
