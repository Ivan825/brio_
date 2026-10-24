"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/button";
import { Chip } from "@/components/chip";
import { FormError, Input, Label } from "@/components/field";
import { api } from "@/lib/api";

export interface NotificationSettingsView {
  prefs: {
    channels: { email: boolean; push: boolean; slack: boolean };
    kinds: { approvals: boolean; questions: boolean; missions: boolean; budgets: boolean };
  };
  push: { enabled: boolean; publicKey: string | null; subscriptions: number };
  email: { provider: "resend" | "log" };
  slack: { connected: boolean; channelId?: string; teamId?: string | null };
}

const CHANNELS = [
  ["email", "Email"],
  ["push", "This browser and your others"],
  ["slack", "The workspace's Slack channel"],
] as const;
const KINDS = [
  ["approvals", "Plans and actions waiting for my yes"],
  ["questions", "Agents' questions"],
  ["missions", "Missions done or failed"],
  ["budgets", "Budget warnings and stops"],
] as const;

const urlB64 = (s: string) => {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

/** What each person hears about and where; this browser's push; the workspace's Slack app. */
export function NotificationSettings({
  view,
  canManage,
}: {
  view: NotificationSettingsView;
  canManage: boolean;
}) {
  const router = useRouter();
  const [prefs, setPrefs] = useState(view.prefs);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slack, setSlack] = useState({ botToken: "", signingSecret: "", channelId: "" });

  const save = async (next: typeof prefs) => {
    setPrefs(next);
    setSaved(false);
    setError(null);
    try {
      await api("/v1/notifications/prefs", { method: "PUT", body: next });
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  async function enablePush() {
    setError(null);
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window))
        throw new Error("this browser cannot receive push notifications");
      if ((await Notification.requestPermission()) !== "granted")
        throw new Error("notifications were not allowed");
      const reg = await navigator.serviceWorker.register("/sw.js");
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64(view.push.publicKey ?? ""),
      });
      await api("/v1/notifications/push", { method: "POST", body: sub.toJSON() });
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function connectSlack(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("/v1/integrations/slack", { method: "PUT", body: slack });
      setSlack({ botToken: "", signingSecret: "", channelId: "" });
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="notification-settings">
      <div className="grid gap-4 sm:grid-cols-2">
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
            Tell me about
          </legend>
          {KINDS.map(([k, label]) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={prefs.kinds[k]}
                onChange={(e) => void save({ ...prefs, kinds: { ...prefs.kinds, [k]: e.target.checked } })}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">By</legend>
          {CHANNELS.map(([k, label]) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={prefs.channels[k]}
                onChange={(e) =>
                  void save({ ...prefs, channels: { ...prefs.channels, [k]: e.target.checked } })
                }
              />
              {label}
            </label>
          ))}
        </fieldset>
      </div>
      {saved && (
        <p role="status" className="font-mono text-2xs text-success">
          saved
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Chip>
          {view.email.provider === "resend" ? "email via Resend" : "email is only logged (no RESEND_API_KEY)"}
        </Chip>
        {view.push.enabled ? (
          <>
            <Chip tone={view.push.subscriptions ? "success" : "muted"}>
              {view.push.subscriptions
                ? `${view.push.subscriptions} browser(s) subscribed`
                : "no browser subscribed"}
            </Chip>
            <Button size="sm" onClick={() => void enablePush()}>
              Turn on notifications in this browser
            </Button>
          </>
        ) : (
          <Chip>browser push is off (no VAPID keys)</Chip>
        )}
      </div>
      <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Slack</span>
          {view.slack.connected ? (
            <Chip tone="success">
              posting to {view.slack.channelId} · team {view.slack.teamId}
            </Chip>
          ) : (
            <Chip>not connected</Chip>
          )}
        </div>
        <p className="text-xs text-fg-muted">
          Your own Slack app (bot scopes chat:write and users:read.email; interactivity URL{" "}
          <span className="font-mono">/v1/integrations/slack/interactions</span>). Approvals get Approve and
          Deny buttons, decided as the member whose Slack email it is.
        </p>
        {canManage && (
          <form onSubmit={connectSlack} className="grid gap-2 sm:grid-cols-3" aria-label="Connect Slack">
            <div className="flex flex-col gap-1">
              <Label htmlFor="slack-token">Bot token</Label>
              <Input
                id="slack-token"
                type="password"
                autoComplete="off"
                placeholder="xoxb-…"
                value={slack.botToken}
                onChange={(e) => setSlack({ ...slack, botToken: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="slack-secret">Signing secret</Label>
              <Input
                id="slack-secret"
                type="password"
                autoComplete="off"
                value={slack.signingSecret}
                onChange={(e) => setSlack({ ...slack, signingSecret: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="slack-channel">Channel id</Label>
              <Input
                id="slack-channel"
                placeholder="C0123456"
                value={slack.channelId}
                onChange={(e) => setSlack({ ...slack, channelId: e.target.value })}
              />
            </div>
            <div className="flex gap-2 sm:col-span-3">
              <Button type="submit" disabled={!slack.botToken || !slack.signingSecret || !slack.channelId}>
                {view.slack.connected ? "Replace" : "Connect Slack"}
              </Button>
              {view.slack.connected && (
                <Button
                  variant="ghost"
                  onClick={async () => {
                    await api("/v1/integrations/slack", { method: "DELETE" }).catch(() => {});
                    router.refresh();
                  }}
                >
                  Disconnect
                </Button>
              )}
            </div>
          </form>
        )}
      </div>
      <FormError>{error}</FormError>
    </div>
  );
}
