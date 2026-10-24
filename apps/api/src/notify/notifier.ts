// The notifier (BUILD_PLAN M9): the events that need people — a plan or an action waiting for a yes, an agent's
// question, a mission's end, a budget warning or stop — reach the right people where they asked to hear: email (Resend),
// their browsers (web push) and the workspace's Slack channel. Every notification is claimed in the log before it is
// sent, so an event never notifies anyone twice, whichever API instance sees it.
import { type DbOrTx, readEventsSince, schema } from "@brio/db";
import type { Event } from "@brio/schema";
import { and, eq, inArray } from "drizzle-orm";
import webpush from "web-push";
import type { AppContext } from "../context";
import { awaitingPerson } from "../orchestrator/plans";
import { SlackClient, slackBlocks } from "./slack";

const { members, missions, notificationPrefs, notifications, pushSubscriptions, slackApps, users } = schema;

type NotificationPrefs = schema.NotificationPrefs;

export type NotifyKind = keyof NotificationPrefs["kinds"];

export const DEFAULT_PREFS: NotificationPrefs = {
  channels: { email: true, push: true, slack: true },
  kinds: { approvals: true, questions: true, missions: true, budgets: true },
};

/** What an event says to people, or null when it says nothing to them. */
export interface Notice {
  kind: NotifyKind;
  title: string;
  body: string;
  /** Where to act on it in the web app. */
  path: string;
  /** Everyone who may act on it (approvals), or the mission's owner. */
  audience: "actors" | "owner" | "owner_and_admins";
  approvalId?: string;
}

export function noticeOf(
  e: Event,
  mission: { id: string; title: string },
  /** Whether the mission's plan is really waiting for a person (not a quick start passing through). */
  planWaiting = false,
): Notice | null {
  const p = e.payload as Record<string, unknown>;
  const board = `/missions/${mission.id}`;
  switch (e.type) {
    case "approval.requested":
      return {
        kind: "approvals",
        title: `Waiting for your yes: ${String(p.what ?? "an action")}`,
        body: `${mission.title}${p.taskKey ? ` · ${p.taskKey}` : ""}${p.branch ? ` · ${p.branch}` : ""}`,
        path: "/inbox",
        audience: "actors",
        ...(typeof p.approvalId === "string" ? { approvalId: p.approvalId } : {}),
      };
    case "plan.proposed":
      return planWaiting
        ? {
            kind: "approvals",
            title: "A plan is waiting for your approval",
            body: `${mission.title} · plan v${p.version}`,
            path: board,
            audience: "owner",
          }
        : null;
    case "message.sent":
      return p.to === "user" && p.kind === "question"
        ? {
            kind: "questions",
            title: "An agent has a question",
            body: `${mission.title}: ${String(p.body ?? "").slice(0, 300)}`,
            path: "/inbox",
            audience: "owner",
          }
        : null;
    case "mission.done":
      return {
        kind: "missions",
        title: "Mission done",
        body: mission.title,
        path: `${board}/report`,
        audience: "owner",
      };
    case "mission.failed":
      return {
        kind: "missions",
        title: "Mission failed",
        body: `${mission.title}: ${String(p.reason ?? "")}`.slice(0, 300),
        path: board,
        audience: "owner",
      };
    case "budget.warn":
    case "budget.stop":
      return {
        kind: "budgets",
        title: e.type === "budget.stop" ? "A budget is spent: work stopped" : "A budget is nearly spent",
        body: `${mission.title} · ${String(p.scope)} budget $${p.limitUsd} · spent $${p.spentUsd}`,
        path: board,
        audience: "owner_and_admins",
      };
    default:
      return null;
  }
}

const TYPES = new Set([
  "approval.requested",
  "plan.proposed",
  "message.sent",
  "mission.done",
  "mission.failed",
  "budget.warn",
  "budget.stop",
]);

export class Notifier {
  private unsubscribe: (() => void) | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly ctx: AppContext) {
    const c = ctx.config;
    if (c.BRIO_VAPID_PUBLIC_KEY && c.BRIO_VAPID_PRIVATE_KEY)
      webpush.setVapidDetails(c.BRIO_VAPID_SUBJECT, c.BRIO_VAPID_PUBLIC_KEY, c.BRIO_VAPID_PRIVATE_KEY);
  }

  get pushEnabled(): boolean {
    return Boolean(this.ctx.config.BRIO_VAPID_PUBLIC_KEY && this.ctx.config.BRIO_VAPID_PRIVATE_KEY);
  }

  start(): void {
    this.unsubscribe = this.ctx.feed.subscribeAll((missionId, seq, hint) => {
      if (!hint.type || !TYPES.has(hint.type)) return;
      this.chain = this.chain.then(() =>
        this.handle(missionId, seq).catch((err: Error) =>
          this.ctx.log.warn({ err: err.message, missionId, seq }, "notification failed"),
        ),
      );
    });
  }

  stop(): void {
    this.unsubscribe?.();
  }

  /** Waits for the notifications queued so far (tests). */
  async idle(): Promise<void> {
    await this.chain;
  }

  async handle(missionId: string, seq: number): Promise<void> {
    const { db } = this.ctx;
    const [e] = await readEventsSince(db, missionId, seq - 1, 1);
    if (!e || e.seq !== seq) return;
    const [m] = await db.select().from(missions).where(eq(missions.id, missionId));
    if (!m) return;
    const notice = noticeOf(e, m, e.type === "plan.proposed" && (await awaitingPerson(db, m)));
    if (!notice) return;
    const url = `${this.ctx.config.APP_URL.replace(/\/+$/, "")}${notice.path}`;

    const people = await this.audience(db, m, notice.audience);
    const prefs = new Map(
      people.length
        ? (
            await db
              .select()
              .from(notificationPrefs)
              .where(
                and(
                  eq(notificationPrefs.workspaceId, m.workspaceId),
                  inArray(
                    notificationPrefs.userId,
                    people.map((p) => p.id),
                  ),
                ),
              )
          ).map((r) => [r.userId, r.prefs])
        : [],
    );
    for (const person of people) {
      const pr = prefs.get(person.id) ?? DEFAULT_PREFS;
      if (!pr.kinds[notice.kind]) continue;
      if (pr.channels.email)
        await this.once(m.workspaceId, e.id, "email", person.id, notice.kind, () =>
          this.ctx.mailer.send({
            to: person.email,
            subject: notice.title,
            text: `${notice.body}\n\nOpen it in Brio: ${url}`,
            link: url,
          }),
        );
      if (pr.channels.push && this.pushEnabled) await this.push(m.workspaceId, e.id, person.id, notice, url);
    }
    await this.slack(m.workspaceId, e.id, notice, url);
  }

  /** Who hears about it: everyone who can act (owners, admins, members), the mission's owner, or them and admins. */
  private async audience(
    db: DbOrTx,
    m: typeof missions.$inferSelect,
    who: Notice["audience"],
  ): Promise<Array<{ id: string; email: string }>> {
    const roles =
      who === "actors" ? ["owner", "admin", "member"] : who === "owner_and_admins" ? ["owner", "admin"] : [];
    const rows = roles.length
      ? await db
          .select({ id: users.id, email: users.email })
          .from(members)
          .innerJoin(users, eq(users.id, members.userId))
          .where(and(eq(members.workspaceId, m.workspaceId), inArray(members.role, roles as ["owner"])))
      : [];
    if (m.createdBy && !rows.some((r) => r.id === m.createdBy)) {
      const [owner] = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.id, m.createdBy));
      if (owner) rows.push(owner);
    }
    return rows;
  }

  /** Claims the notification in the log, then sends it; a failure is recorded on the claim. */
  private async once(
    workspaceId: string,
    eventId: string,
    channel: string,
    userId: string | null,
    kind: NotifyKind,
    send: () => Promise<unknown>,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    const [claimed] = await this.ctx.db
      .insert(notifications)
      .values({ workspaceId, eventId, channel, userId, kind, detail })
      .onConflictDoNothing()
      .returning({ id: notifications.id });
    if (!claimed) return;
    try {
      await send();
    } catch (err) {
      await this.ctx.db
        .update(notifications)
        .set({ status: "failed", error: this.ctx.redactor.redact((err as Error).message).slice(0, 500) })
        .where(eq(notifications.id, claimed.id));
    }
  }

  private async push(workspaceId: string, eventId: string, userId: string, n: Notice, url: string) {
    const subs = await this.ctx.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
    if (!subs.length) return;
    await this.once(workspaceId, eventId, "push", userId, n.kind, async () => {
      const payload = JSON.stringify({ title: n.title, body: n.body, url, tag: eventId });
      const failures: string[] = [];
      for (const s of subs) {
        try {
          // Encrypted and signed by web-push; sent through Brio's guarded fetch (the endpoint is a URL a browser gave).
          const r = webpush.generateRequestDetails({ endpoint: s.endpoint, keys: s.keys }, payload, {
            TTL: 3600,
          });
          const res = await this.ctx.fetch(r.endpoint, {
            method: r.method,
            headers: r.headers as Record<string, string>,
            body: new Uint8Array(r.body as Buffer),
          });
          if (res.status === 404 || res.status === 410) {
            // The browser dropped the subscription: forget it.
            await this.ctx.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
            continue;
          }
          if (!res.ok) throw new Error(`the push service answered HTTP ${res.status}`);
          await this.ctx.db
            .update(pushSubscriptions)
            .set({ lastUsedAt: new Date() })
            .where(eq(pushSubscriptions.id, s.id));
        } catch (err) {
          failures.push((err as Error).message);
        }
      }
      if (failures.length === subs.length) throw new Error(failures[0] ?? "push failed");
    });
  }

  private async slack(workspaceId: string, eventId: string, n: Notice, url: string) {
    const [app] = await this.ctx.db
      .select()
      .from(slackApps)
      .where(and(eq(slackApps.workspaceId, workspaceId), eq(slackApps.enabled, true)));
    if (!app) return;
    await this.once(
      workspaceId,
      eventId,
      "slack",
      null,
      n.kind,
      async () => {
        const token = (await this.ctx.vault.reveal(this.ctx.db, workspaceId, app.botTokenRef)).reveal();
        const client = new SlackClient({
          token,
          fetch: this.ctx.fetch,
          apiUrl: this.ctx.config.BRIO_SLACK_API_URL,
        });
        await client.postMessage(
          app.channelId,
          `${n.title}: ${n.body}`,
          slackBlocks(
            `*${n.title}*\n${n.body}`,
            url,
            n.approvalId ? { workspaceId, approvalId: n.approvalId } : undefined,
          ),
        );
      },
      { channel: app.channelId },
    );
  }
}
