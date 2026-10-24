// Notifications and approvals beyond the web app (M9): each person's preferences, their browsers' push
// subscriptions, the workspace's Slack app, and Slack's callback when someone presses Approve or Deny.
import { schema } from "@brio/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { decideApproval } from "../deliveries";
import { HttpError, requireMember, requireSession, requireSignedIn, workspaceFor } from "../http";
import { DEFAULT_PREFS } from "../notify/notifier";
import { SlackClient, verifySlackSignature } from "../notify/slack";

const { members, notificationPrefs, notifications, pushSubscriptions, slackApps, users } = schema;

const Prefs = z.object({
  channels: z.object({ email: z.boolean(), push: z.boolean(), slack: z.boolean() }),
  kinds: z.object({
    approvals: z.boolean(),
    questions: z.boolean(),
    missions: z.boolean(),
    budgets: z.boolean(),
  }),
});
const Subscription = z.object({
  endpoint: z.url().max(2000),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
});
const SlackConnect = z.object({
  botToken: z
    .string()
    .trim()
    .regex(/^xoxb-/, "a bot token (xoxb-…)"),
  signingSecret: z.string().trim().min(16).max(200),
  channelId: z
    .string()
    .trim()
    .regex(/^[CG][A-Z0-9]{6,}$/, "a channel id (C…)"),
});

export async function notificationRoutes(app: FastifyInstance, ctx: AppContext) {
  /** Your notification channels and kinds, and what the workspace has connected (email, push, Slack). */
  app.get("/v1/notifications/prefs", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s);
    const [row] = await ctx.db
      .select()
      .from(notificationPrefs)
      .where(and(eq(notificationPrefs.workspaceId, workspaceId), eq(notificationPrefs.userId, s.userId)));
    const [slack] = await ctx.db.select().from(slackApps).where(eq(slackApps.workspaceId, workspaceId));
    const subs = await ctx.db
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, s.userId));
    return {
      prefs: row?.prefs ?? DEFAULT_PREFS,
      push: {
        enabled: Boolean(ctx.config.BRIO_VAPID_PUBLIC_KEY && ctx.config.BRIO_VAPID_PRIVATE_KEY),
        publicKey: ctx.config.BRIO_VAPID_PUBLIC_KEY ?? null,
        subscriptions: subs.length,
      },
      email: { provider: ctx.config.email },
      slack: slack
        ? { connected: true, channelId: slack.channelId, teamId: slack.teamId, enabled: slack.enabled }
        : { connected: false },
    };
  });

  /** Sets which channels and kinds of events reach you. */
  app.put("/v1/notifications/prefs", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s);
    const prefs = Prefs.parse(req.body);
    await ctx.db
      .insert(notificationPrefs)
      .values({ workspaceId, userId: s.userId, prefs })
      .onConflictDoUpdate({
        target: [notificationPrefs.workspaceId, notificationPrefs.userId],
        set: { prefs },
      });
    return { prefs };
  });

  /** A browser asks to be notified (web push); the same endpoint again just refreshes its keys. */
  app.post("/v1/notifications/push", async (req, reply) => {
    const s = await requireSession(ctx, req);
    requireSignedIn(s, "subscribe a browser");
    const sub = Subscription.parse(req.body);
    await ctx.db
      .insert(pushSubscriptions)
      .values({
        userId: s.userId,
        endpoint: sub.endpoint,
        keys: sub.keys,
        userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300),
      })
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { userId: s.userId, keys: sub.keys } });
    return reply.status(201).send({ subscribed: true });
  });

  /** Removes this browser's push subscription. */
  app.delete("/v1/notifications/push", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const { endpoint } = z.object({ endpoint: z.url() }).parse(req.body);
    await ctx.db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, s.userId)));
    return reply.status(204).send();
  });

  /** What Brio has sent the caller lately in this workspace (and channel messages). */
  app.get("/v1/notifications", async (req) => {
    const s = await requireSession(ctx, req);
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s);
    const rows = await ctx.db
      .select()
      .from(notifications)
      .where(eq(notifications.workspaceId, workspaceId))
      .orderBy(desc(notifications.createdAt))
      .limit(100);
    return {
      notifications: rows
        .filter((n) => n.userId === null || n.userId === s.userId)
        .map(({ id, channel, kind, status, error, createdAt, eventId }) => ({
          id,
          channel,
          kind,
          status,
          error,
          createdAt,
          eventId,
        })),
    };
  });

  /** Connects the workspace's own Slack app: its bot token and signing secret go to the vault. */
  app.put("/v1/integrations/slack", async (req) => {
    const s = await requireSession(ctx, req);
    requireSignedIn(s, "connect Slack");
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s, ["owner", "admin"]);
    const body = SlackConnect.parse(req.body);
    const who = await new SlackClient({
      token: body.botToken,
      fetch: ctx.fetch,
      apiUrl: ctx.config.BRIO_SLACK_API_URL,
    })
      .authTest()
      .catch((e: Error) => {
        throw new HttpError(422, `Slack refused the token: ${e.message}`, "slack_refused");
      });
    const row = await ctx.db.transaction(async (tx) => {
      const token = await ctx.vault.put(tx, {
        workspaceId,
        label: `slack:${workspaceId}:bot:${Date.now()}`,
        value: body.botToken,
        createdBy: s.userId,
      });
      const secret = await ctx.vault.put(tx, {
        workspaceId,
        label: `slack:${workspaceId}:signing:${Date.now()}`,
        value: body.signingSecret,
        createdBy: s.userId,
      });
      const [r] = await tx
        .insert(slackApps)
        .values({
          workspaceId,
          teamId: who.team_id,
          channelId: body.channelId,
          botTokenRef: token.id,
          signingSecretRef: secret.id,
        })
        .onConflictDoUpdate({
          target: slackApps.workspaceId,
          set: {
            teamId: who.team_id,
            channelId: body.channelId,
            botTokenRef: token.id,
            signingSecretRef: secret.id,
            enabled: true,
          },
        })
        .returning();
      await ctx.ledger.append(tx, {
        workspaceId,
        kind: "key.added",
        payload: {
          slack: { teamId: who.team_id, channelId: body.channelId },
          secrets: [token.id, secret.id],
          by: s.userId,
        },
      });
      return r;
    });
    return { slack: { connected: true, teamId: row?.teamId, team: who.team, channelId: row?.channelId } };
  });

  /** Disconnects the workspace's Slack app. */
  app.delete("/v1/integrations/slack", async (req, reply) => {
    const s = await requireSession(ctx, req);
    requireSignedIn(s, "disconnect Slack");
    const workspaceId = workspaceFor(req, s);
    await requireMember(ctx, workspaceId, s, ["owner", "admin"]);
    const [row] = await ctx.db.delete(slackApps).where(eq(slackApps.workspaceId, workspaceId)).returning();
    if (row)
      await ctx.ledger.append(ctx.db, {
        workspaceId,
        kind: "key.removed",
        payload: { slack: { teamId: row.teamId }, by: s.userId },
      });
    return reply.status(204).send();
  });

  // Slack's interactivity callback: its body must be kept raw to check the signature.
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_req, body, done) => done(null, body),
    );
    scope.post("/v1/integrations/slack/interactions", async (req, reply) => {
      const raw = String(req.body ?? "");
      const payload = JSON.parse(new URLSearchParams(raw).get("payload") ?? "{}") as {
        user?: { id?: string };
        actions?: Array<{ value?: string }>;
        response_url?: string;
      };
      let value: { w?: string; a?: string; d?: string } = {};
      try {
        value = JSON.parse(payload.actions?.[0]?.value ?? "{}");
      } catch {}
      const ids = z.object({ w: z.uuid(), a: z.uuid(), d: z.enum(["approve", "deny"]) }).safeParse(value);
      if (!ids.success) return reply.status(400).send({ error: "not a Brio action" });
      const [app] = await ctx.db.select().from(slackApps).where(eq(slackApps.workspaceId, ids.data.w));
      if (!app) return reply.status(404).send({ error: "no Slack app" });
      const secret = (await ctx.vault.reveal(ctx.db, app.workspaceId, app.signingSecretRef)).reveal();
      const sig = req.headers["x-slack-signature"];
      const ts = req.headers["x-slack-request-timestamp"];
      if (!verifySlackSignature(secret, { signature: String(sig ?? ""), timestamp: String(ts ?? "") }, raw))
        return reply.status(401).send({ error: "bad signature" });

      const token = (await ctx.vault.reveal(ctx.db, app.workspaceId, app.botTokenRef)).reveal();
      const slack = new SlackClient({ token, fetch: ctx.fetch, apiUrl: ctx.config.BRIO_SLACK_API_URL });
      const answer = async (text: string) => {
        if (
          payload.response_url?.startsWith("https://hooks.slack.com/") ||
          payload.response_url?.startsWith(ctx.config.BRIO_SLACK_API_URL)
        )
          await ctx
            .fetch(payload.response_url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ replace_original: false, response_type: "ephemeral", text }),
            })
            .catch(() => {});
        return reply.status(200).send({ text });
      };
      // The person who pressed: their Slack email must be a member who may decide.
      const email = payload.user?.id ? await slack.emailOf(payload.user.id).catch(() => null) : null;
      if (!email) return answer("Brio could not tell who you are (the app needs users:read.email).");
      const [member] = await ctx.db
        .select({ userId: users.id, role: members.role })
        .from(users)
        .innerJoin(members, and(eq(members.userId, users.id), eq(members.workspaceId, app.workspaceId)))
        .where(
          and(eq(users.email, email.toLowerCase()), inArray(members.role, ["owner", "admin", "member"])),
        );
      if (!member) return answer(`${email} is not a member of this Brio workspace who can decide approvals.`);
      try {
        const { approval } = await decideApproval(ctx, {
          approvalId: ids.data.a,
          workspaceId: app.workspaceId,
          userId: member.userId,
          approve: ids.data.d === "approve",
          reason: "decided in Slack",
        });
        return answer(`${approval.status === "approved" ? "Approved" : "Denied"} by ${email}.`);
      } catch (err) {
        return answer((err as Error).message);
      }
    });
  });
}
