// Slack (M9): a workspace's own Slack app posts what needs people to a channel, with Approve and Deny buttons on
// approvals; Slack calls Brio back when one is pressed. Requests from Slack are verified with the app's signing secret
// (v0 HMAC over the timestamp and raw body, at most five minutes old), and the person who pressed is found by their
// Slack email among the workspace's members. Web API facts checked against api.slack.com on 24 Oct 2026.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FetchLike } from "@brio/adapters";

export interface SlackBlock {
  type: string;
  [k: string]: unknown;
}

export class SlackClient {
  constructor(private readonly o: { token: string; fetch: FetchLike; apiUrl?: string }) {}

  private async call<T extends { ok: boolean; error?: string }>(
    method: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const res = await this.o.fetch(
      `${(this.o.apiUrl ?? "https://slack.com/api").replace(/\/+$/, "")}/${method}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.o.token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      },
    );
    const json = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as T;
    if (!json.ok) throw new Error(`Slack ${method}: ${json.error ?? "failed"}`);
    return json;
  }

  /** Read methods take their arguments as a query string (JSON bodies are for methods that write). */
  private async get<T extends { ok: boolean; error?: string }>(
    method: string,
    params: Record<string, string>,
  ) {
    const q = new URLSearchParams(params).toString();
    const res = await this.o.fetch(
      `${(this.o.apiUrl ?? "https://slack.com/api").replace(/\/+$/, "")}/${method}${q ? `?${q}` : ""}`,
      { method: "GET", headers: { Authorization: `Bearer ${this.o.token}` } },
    );
    const json = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as T;
    if (!json.ok) throw new Error(`Slack ${method}: ${json.error ?? "failed"}`);
    return json;
  }

  /** Who the token is: its team (checked when the app is connected). */
  authTest() {
    return this.get<{ ok: boolean; team_id: string; team: string; user_id: string }>("auth.test", {});
  }

  postMessage(channel: string, text: string, blocks?: SlackBlock[]) {
    return this.call<{ ok: boolean; ts: string; channel: string }>("chat.postMessage", {
      channel,
      text,
      ...(blocks ? { blocks } : {}),
      unfurl_links: false,
    });
  }

  /** The email of the Slack user who pressed a button (needs users:read.email). */
  async emailOf(userId: string): Promise<string | null> {
    const r = await this.get<{ ok: boolean; user?: { profile?: { email?: string } } }>("users.info", {
      user: userId,
    });
    return r.user?.profile?.email ?? null;
  }
}

/** Whether a request really comes from Slack: v0=HMAC-SHA256(secret, "v0:<ts>:<raw body>"), fresh. */
export function verifySlackSignature(
  secret: string,
  headers: { timestamp?: string; signature?: string },
  rawBody: string,
  now = Date.now(),
): boolean {
  const ts = Number(headers.timestamp);
  if (!headers.signature || !Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 300) return false;
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${rawBody}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(headers.signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A message's blocks: the text, a link, and for an approval the two buttons (the values carry what to decide). */
export function slackBlocks(
  text: string,
  link: string,
  approval?: { workspaceId: string; approvalId: string },
): SlackBlock[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: `${text}\n<${link}|Open in Brio>` } },
    ...(approval
      ? [
          {
            type: "actions",
            elements: (["approve", "deny"] as const).map((decision) => ({
              type: "button",
              action_id: `brio_${decision}`,
              text: { type: "plain_text", text: decision === "approve" ? "Approve" : "Deny" },
              ...(decision === "approve" ? { style: "primary" } : { style: "danger" }),
              value: JSON.stringify({ w: approval.workspaceId, a: approval.approvalId, d: decision }),
            })),
          },
        ]
      : []),
  ];
}
