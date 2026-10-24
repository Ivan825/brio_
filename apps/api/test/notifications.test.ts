// M9: notifications and approvals beyond the web app. An action waiting for a yes reaches its people by email (Resend),
// in their browsers (web push, encrypted and VAPID-signed) and in the workspace's Slack channel with Approve and Deny
// buttons; pressing Approve in Slack (a request signed with the app's secret, from a member's Slack account) decides it.
// Each event notifies each person once; preferences are respected. Needs Postgres.
import { createECDH, createHmac, randomBytes } from "node:crypto";
import { schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import webpush from "web-push";
import { APP_URL, Client, type Harness, startHarness } from "./helpers";

const SIGNING = ["slack", "signing", "0123456789abcdef0123"].join("-");
const BOT = ["xoxb", "1111", "2222", "notifytest0123456789"].join("-");

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: string;
}

describe.skipIf(!hasTestDatabase)("M9: notifications and approvals beyond the web app", () => {
  const vapid = webpush.generateVAPIDKeys();
  const seen: Seen[] = [];
  const of = (prefix: string) => seen.filter((s) => s.url.startsWith(prefix));
  let h: Harness;
  let c: Client;
  let workspaceId: string;
  let missionId: string;
  let approvalId: string;

  beforeAll(async () => {
    h = await startHarness({
      runner: false,
      env: {
        RESEND_API_KEY: ["re", "notifytest0123456789"].join("_"),
        BRIO_EMAIL_FROM: "Brio <brio@mail.example.com>",
        BRIO_VAPID_PUBLIC_KEY: vapid.publicKey,
        BRIO_VAPID_PRIVATE_KEY: vapid.privateKey,
        BRIO_VAPID_SUBJECT: "mailto:ops@example.com",
        BRIO_SLACK_API_URL: "https://slack.test/api",
      },
      fetch: async (input, init) => {
        const url = String(input);
        const headers = Object.fromEntries(new Headers(init?.headers).entries());
        const body =
          init?.body instanceof Uint8Array
            ? Buffer.from(init.body).toString("base64")
            : String(init?.body ?? "");
        seen.push({ url, headers, body });
        const json = (v: unknown, status = 200) =>
          new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
        if (url === "https://api.resend.com/emails") return json({ id: "email-1" });
        if (url.startsWith("https://slack.test/api/auth.test"))
          return json({ ok: true, team_id: "T1", team: "Acme", user_id: "U0" });
        if (url.startsWith("https://slack.test/api/chat.postMessage"))
          return json({ ok: true, ts: "1.2", channel: "C123456" });
        if (url.startsWith("https://slack.test/api/users.info"))
          return json({
            ok: true,
            user: { profile: { email: url.includes("U9") ? "notify@example.com" : "stranger@example.com" } },
          });
        if (url.startsWith("https://push.example.com/")) return new Response(null, { status: 201 });
        if (url.startsWith("https://hooks.slack.com/")) return new Response("ok");
        return new Response("{}", { status: 404 });
      },
    });
    c = new Client(h);
    await c.signIn("notify@example.com");
    workspaceId = (await c.request("POST", "/v1/workspaces", { name: "Notify" })).json().workspace.id;
    missionId = (
      await c.request("POST", "/v1/missions", {
        goal: "Ship it",
        plan: {
          tasks: [
            {
              key: "t",
              type: "write.summary",
              title: "T",
              contract: {
                objective: "T",
                inputs: [],
                outputs: [{ kind: "report", description: "t" }],
                acceptance: [{ kind: "diff_scope", hard: true }],
                constraints: [],
                sensitivity: "internal",
              },
              dependsOn: [],
              suggestedMode: "single",
            },
          ],
          assumptions: [],
          questions: [],
        },
      })
    ).json().mission.id;
  });
  afterAll(async () => {
    await h?.close();
  });

  /** An action waiting for a yes, as a finished mission's delivery would ask. */
  async function askForApproval(): Promise<{ seq: number; id: string }> {
    const [a] = await h.db.db
      .insert(schema.approvals)
      .values({
        workspaceId,
        subjectKind: "mission",
        subjectId: missionId,
        action: "open_pull_request",
        requestedBy: "brio",
      })
      .returning();
    approvalId = a!.id;
    const e = await h.server.ctx.events.append(h.db.db, {
      workspaceId,
      missionId,
      type: "approval.requested",
      actor: "system",
      payload: { what: "open a pull request", approvalId, branch: "brio/ship-it" },
    });
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 50));
      await h.server.ctx.notifier.idle();
      const n = await h.db.db
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.eventId, e.id));
      if (n.length) break;
    }
    return { seq: e.seq, id: e.id };
  }

  it("connects Slack and a browser", async () => {
    const slack = await c.request("PUT", "/v1/integrations/slack", {
      botToken: BOT,
      signingSecret: SIGNING,
      channelId: "C123456",
    });
    expect(slack.statusCode, slack.body).toBe(200);
    expect(slack.json().slack).toMatchObject({ connected: true, teamId: "T1", channelId: "C123456" });
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const sub = await c.request("POST", "/v1/notifications/push", {
      endpoint: "https://push.example.com/send/abc",
      keys: {
        p256dh: ecdh.getPublicKey().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
      },
    });
    expect(sub.statusCode, sub.body).toBe(201);
    const prefs = (await c.request("GET", "/v1/notifications/prefs")).json();
    expect(prefs).toMatchObject({
      push: { enabled: true, publicKey: vapid.publicKey, subscriptions: 1 },
      email: { provider: "resend" },
      slack: { connected: true },
    });
    expect(JSON.stringify(await h.db.db.select().from(schema.slackApps))).not.toContain(BOT);
  });

  it("tells its people by email, in their browsers and in Slack, once", async () => {
    seen.length = 0;
    const { seq, id: eventId } = await askForApproval();
    const [email] = of("https://api.resend.com/emails");
    expect(email?.headers.authorization).toMatch(/^Bearer re_/);
    expect(JSON.parse(email!.body)).toMatchObject({
      from: "Brio <brio@mail.example.com>",
      to: ["notify@example.com"],
      subject: "Waiting for your yes: open a pull request",
    });
    expect(JSON.parse(email!.body).text).toContain(`${APP_URL}/inbox`);

    const [push] = of("https://push.example.com/");
    expect(push?.headers["content-encoding"]).toBe("aes128gcm");
    expect(push?.headers.authorization).toMatch(/^vapid t=.+, k=/);
    expect(push?.headers.ttl).toBe("3600");

    const [post] = of("https://slack.test/api/chat.postMessage");
    const message = JSON.parse(post!.body);
    expect(message.channel).toBe("C123456");
    const buttons = message.blocks.find((b: { type: string }) => b.type === "actions").elements;
    expect(buttons.map((b: { text: { text: string } }) => b.text.text)).toEqual(["Approve", "Deny"]);

    // The same event again notifies nobody again.
    seen.length = 0;
    await h.server.ctx.notifier.handle(missionId, seq);
    expect(seen).toEqual([]);
    const log = await h.db.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.eventId, eventId));
    expect(log.map((n) => n.channel).sort()).toEqual(["email", "push", "slack"]);
    expect(log.every((n) => n.status === "sent")).toBe(true);
  });

  it("respects a person's preferences", async () => {
    const put = await c.request("PUT", "/v1/notifications/prefs", {
      channels: { email: false, push: true, slack: true },
      kinds: { approvals: true, questions: true, missions: false, budgets: true },
    });
    expect(put.statusCode, put.body).toBe(200);
    seen.length = 0;
    await askForApproval();
    expect(of("https://api.resend.com/emails")).toEqual([]);
    expect(of("https://push.example.com/")).toHaveLength(1);
  });

  it("decides an approval from Slack, as the member whose Slack email it is; forged requests are refused", async () => {
    const posted = of("https://slack.test/api/chat.postMessage").at(-1);
    const value = JSON.parse(posted!.body).blocks.find((b: { type: string }) => b.type === "actions")
      .elements[0].value;
    const send = (user: string, secret = SIGNING, ts = Math.floor(Date.now() / 1000)) => {
      const body = new URLSearchParams({
        payload: JSON.stringify({
          type: "block_actions",
          user: { id: user },
          actions: [{ action_id: "brio_approve", value }],
          response_url: "https://hooks.slack.com/actions/T1/1/xyz",
        }),
      }).toString();
      const sig = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
      return h.server.app.inject({
        method: "POST",
        url: "/v1/integrations/slack/interactions",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-signature": sig,
          "x-slack-request-timestamp": String(ts),
        },
        payload: body,
      });
    };
    expect((await send("U9", "not-the-secret-0123456789")).statusCode).toBe(401);
    expect((await send("U9", SIGNING, Math.floor(Date.now() / 1000) - 3600)).statusCode).toBe(401);
    const stranger = await send("U5");
    expect(stranger.json().text).toContain("stranger@example.com is not a member");
    const ok = await send("U9");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().text).toBe("Approved by notify@example.com.");
    const [a] = await h.db.db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
    expect(a).toMatchObject({ status: "approved", reason: "decided in Slack" });
    expect((await send("U9")).json().text).toContain("already approved");
  });
});
