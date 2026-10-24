"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/button";
import { Chip } from "@/components/chip";
import { FormError, Input, Label } from "@/components/field";
import { api } from "@/lib/api";
import { usd } from "@/lib/format";

const heading = "font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted";

export type MandateView =
  | { connected: false }
  | {
      connected: true;
      baseUrl: string;
      mandateId: string;
      name: string;
      currency: string;
      live:
        | { reachable: false; error: string }
        | {
            reachable: true;
            status: string;
            frozen: boolean;
            remaining: { today: number | null; total: number | null } | null;
            pendingApprovals: number;
          }
        | null;
      holds: Array<{
        id: string;
        taskTitle: string;
        status: string;
        amountCents: number;
        capturedCents: number | null;
        merchant: string;
        reason: string | null;
      }>;
    };

const HOLD_TONE: Record<string, "muted" | "info" | "success" | "warning" | "danger"> = {
  pending: "warning",
  held: "info",
  captured: "success",
  voided: "muted",
  declined: "danger",
};

const cents = (n: number | null | undefined) => (n === null || n === undefined ? "–" : usd(n / 100));

/** The workspace's Mandate (D-07): spend authority held outside Brio, asked before every paid attempt. */
export function Mandate({ view, canEdit }: { view: MandateView; canEdit: boolean }) {
  const router = useRouter();
  const [form, setForm] = useState({ baseUrl: "", token: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/v1/integrations/mandate", { method: "PUT", body: form });
      setForm({ baseUrl: "", token: "" });
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    setError(null);
    try {
      await api("/v1/integrations/mandate", { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section aria-labelledby="mandate-title" className="flex flex-col gap-3" data-testid="mandate">
      <h2 id="mandate-title" className={heading}>
        Mandate
      </h2>
      <p className="text-xs text-fg-muted">
        Optional. With a mandate connected, every paid attempt first asks it for authority to spend up to the
        attempt&apos;s limit with the vendor that bills it, and the real cost is captured when the attempt
        ends. Spend a person must approve waits in Mandate&apos;s inbox. If Mandate cannot be reached, nothing
        paid runs.
      </p>
      {view.connected ? (
        <div className="flex flex-col gap-3 rounded-lg border border-line p-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-fg">{view.name}</span>
            <Chip>{view.mandateId}</Chip>
            <span className="font-mono text-2xs text-fg-subtle">{view.baseUrl}</span>
            {view.live?.reachable === false && <Chip tone="danger">unreachable</Chip>}
            {view.live?.reachable && (
              <Chip tone={view.live.status === "active" && !view.live.frozen ? "success" : "warning"}>
                {view.live.frozen ? "frozen" : view.live.status}
              </Chip>
            )}
          </div>
          {view.live?.reachable && (
            <p className="font-mono text-xs text-fg-muted">
              left today {cents(view.live.remaining?.today)} · left in total{" "}
              {cents(view.live.remaining?.total)}
              {view.live.pendingApprovals ? ` · ${view.live.pendingApprovals} waiting for a yes` : ""}
            </p>
          )}
          {view.holds.length > 0 && (
            <ul className="divide-y divide-line text-sm" data-testid="mandate-holds">
              {view.holds.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center gap-2 py-1.5">
                  <Chip tone={HOLD_TONE[h.status] ?? "muted"}>{h.status}</Chip>
                  <span className="text-fg">{h.taskTitle}</span>
                  <span className="font-mono text-2xs text-fg-subtle">
                    {h.merchant} · held {cents(h.amountCents)}
                    {h.capturedCents !== null ? ` · spent ${cents(h.capturedCents)}` : ""}
                  </span>
                  {(h.status === "pending" || h.status === "declined") && h.reason && (
                    <span className="text-xs text-fg-muted">{h.reason}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canEdit && (
            <div>
              <Button size="sm" onClick={() => void disconnect()}>
                Disconnect
              </Button>
            </div>
          )}
        </div>
      ) : canEdit ? (
        <form
          aria-label="Connect Mandate"
          onSubmit={connect}
          className="flex flex-col gap-3 rounded-lg border border-line p-4"
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="mandate-url">Mandate URL</Label>
            <Input
              id="mandate-url"
              type="url"
              required
              placeholder="https://mandate.example.com"
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="mandate-token">Agent token (mnd_…)</Label>
            <Input
              id="mandate-token"
              type="password"
              required
              autoComplete="off"
              value={form.token}
              onChange={(e) => setForm({ ...form, token: e.target.value })}
            />
            <p className="text-2xs text-fg-subtle">
              Issue a USD mandate for Brio in Mandate and paste its token. It is kept in the vault.
            </p>
          </div>
          <div>
            <Button type="submit" variant="primary" disabled={busy}>
              Connect Mandate
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-sm text-fg-muted">Not connected.</p>
      )}
      <FormError>{error}</FormError>
    </section>
  );
}
