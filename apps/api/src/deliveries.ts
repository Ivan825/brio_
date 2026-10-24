// Deliveries (BUILD_PLAN M8, CLAUDE.md rule 6): when a mission on a repository ends with its work integrated, Brio
// proposes handing it back — the integration commit pushed as a branch, and a pull request opened when the
// repository is on GitHub. Pushing is irreversible, so the delivery waits on an approval a person decides; only then
// does a runner push. Every decision is in the audit ledger and on the mission's event stream.
import { type DbOrTx, schema } from "@brio/db";
import { enqueueDelivery, githubRepoOf } from "@brio/runner";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { AppContext } from "./context";
import { HttpError } from "./http";
import { requireRunnerOwner } from "./runner-owner";
import { pokeRunner } from "./runners/hub";

const { approvals, deliveries, integrations, missions, projects } = schema;

type Mission = typeof missions.$inferSelect;
type Integration = typeof integrations.$inferSelect;
export type Delivery = typeof deliveries.$inferSelect;

export const DELIVERY_ACTION = { pull_request: "open a pull request", branch: "push a branch" } as const;

/** brio/<title words>-<mission id prefix>: readable on the host, unique per mission. */
export function deliveryBranch(m: Pick<Mission, "id" | "title">): string {
  const words = m.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `brio/${words ? `${words}-` : ""}${m.id.slice(0, 8)}`;
}

export const presentDelivery = (d: Delivery) => ({
  id: d.id,
  missionId: d.missionId,
  approvalId: d.approvalId,
  kind: d.kind,
  status: d.status,
  repo: d.repo,
  branch: d.branch,
  commit: d.commit,
  title: d.title,
  url: d.url,
  number: d.number,
  error: d.error,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});

/**
 * Proposes delivering a mission's integrated work: an approval and the delivery it unlocks. Nothing for missions
 * without a repository or without integrated work, and nothing while another delivery is waiting or under way.
 */
export async function proposeDelivery(
  ctx: AppContext,
  db: DbOrTx,
  m: Mission,
  integration: Integration | null,
  requestedBy = "brio",
): Promise<Delivery | null> {
  if (!m.projectId) return null;
  const [project] = await db.select().from(projects).where(eq(projects.id, m.projectId));
  if (!project?.repoUrl) return null;
  const work = integration ?? (await latestPassed(db, m.id));
  const commit = work?.commit ?? work?.branch;
  if (!work || work.status !== "passed" || !commit) return null;
  const [open] = await db
    .select()
    .from(deliveries)
    .where(
      and(
        eq(deliveries.missionId, m.id),
        inArray(deliveries.status, ["awaiting_approval", "queued", "running", "done"]),
      ),
    )
    .limit(1);
  if (open) return null;
  // On a local runner the branch goes into the person's own repository; pull requests need a cloud project's token.
  const kind =
    !project.runnerId && githubRepoOf(project.repoUrl, project.settings) ? "pull_request" : "branch";
  const [approval] = await db
    .insert(approvals)
    .values({
      workspaceId: m.workspaceId,
      subjectKind: "mission",
      subjectId: m.id,
      action: kind === "pull_request" ? "open_pull_request" : "push_branch",
      requestedBy,
    })
    .returning();
  if (!approval) return null;
  const [d] = await db
    .insert(deliveries)
    .values({
      workspaceId: m.workspaceId,
      missionId: m.id,
      integrationId: work.id,
      approvalId: approval.id,
      kind,
      repo: { url: project.repoUrl, base: project.defaultBranch ?? null },
      branch: deliveryBranch(m),
      commit,
      title: m.title,
    })
    .returning();
  if (!d) return null;
  await ctx.events.append(db, {
    workspaceId: m.workspaceId,
    missionId: m.id,
    type: "approval.requested",
    actor: requestedBy === "brio" ? "system" : `user:${requestedBy}`,
    payload: {
      what: DELIVERY_ACTION[kind],
      approvalId: approval.id,
      deliveryId: d.id,
      repo: project.repoUrl,
      branch: d.branch,
    },
  });
  return d;
}

async function latestPassed(db: DbOrTx, missionId: string): Promise<Integration | null> {
  const [row] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.missionId, missionId), eq(integrations.status, "passed")))
    .orderBy(desc(integrations.planVersion), desc(integrations.round))
    .limit(1);
  return row ?? null;
}

/**
 * A person decides an approval. Only a pending one can be decided, once; approving a delivery queues it for a runner,
 * denying it closes it.
 */
export async function decideApproval(
  ctx: AppContext,
  i: { approvalId: string; workspaceId: string; userId: string; approve: boolean; reason?: string },
) {
  // A push or pull request from someone's machine goes out with their git access: only they say yes to it.
  const [subject] = await ctx.db
    .select({ projectId: missions.projectId })
    .from(approvals)
    .innerJoin(missions, and(eq(approvals.subjectKind, "mission"), eq(missions.id, approvals.subjectId)))
    .where(and(eq(approvals.id, i.approvalId), eq(approvals.workspaceId, i.workspaceId)));
  if (subject)
    await requireRunnerOwner(ctx.db, subject.projectId, i.userId, "decide what leaves the machine");
  const decided = await ctx.db.transaction(async (tx) => {
    const [a] = await tx
      .update(approvals)
      .set({
        status: i.approve ? "approved" : "denied",
        decidedBy: i.userId,
        decidedAt: new Date(),
        reason: i.reason ?? null,
      })
      .where(
        and(
          eq(approvals.id, i.approvalId),
          eq(approvals.workspaceId, i.workspaceId),
          eq(approvals.status, "pending"),
        ),
      )
      .returning();
    if (!a) {
      const [exists] = await tx
        .select()
        .from(approvals)
        .where(and(eq(approvals.id, i.approvalId), eq(approvals.workspaceId, i.workspaceId)));
      if (!exists) throw new HttpError(404, "approval not found", "not_found");
      throw new HttpError(409, `this approval was already ${exists.status}`, "already_decided");
    }
    const [d] = await tx
      .update(deliveries)
      .set({ status: i.approve ? "queued" : "denied" })
      .where(and(eq(deliveries.approvalId, a.id), eq(deliveries.status, "awaiting_approval")))
      .returning();
    await ctx.ledger.append(tx, {
      workspaceId: i.workspaceId,
      kind: "approval.decision",
      payload: {
        approvalId: a.id,
        action: a.action,
        subject: { kind: a.subjectKind, id: a.subjectId },
        decision: a.status,
        by: i.userId,
        ...(i.reason ? { reason: i.reason } : {}),
      },
    });
    if (a.subjectKind === "mission")
      await ctx.events.append(tx, {
        workspaceId: i.workspaceId,
        missionId: a.subjectId,
        type: "approval.decided",
        actor: `user:${i.userId}`,
        payload: {
          approvalId: a.id,
          action: a.action,
          decision: a.status,
          ...(d ? { deliveryId: d.id } : {}),
          ...(i.reason ? { reason: i.reason } : {}),
        },
      });
    return { approval: a, delivery: d ?? null };
  });
  if (decided.delivery?.status === "queued") {
    const [p] = await ctx.db
      .select({ runnerId: projects.runnerId })
      .from(projects)
      .innerJoin(missions, eq(missions.projectId, projects.id))
      .where(eq(missions.id, decided.delivery.missionId));
    if (p?.runnerId) await pokeRunner(ctx.db, p.runnerId);
    else await enqueueDelivery(ctx.queue, decided.delivery.id);
  }
  return decided;
}
