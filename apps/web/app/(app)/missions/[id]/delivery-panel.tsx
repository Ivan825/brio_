"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { Chip } from "@/components/chip";
import { FormError } from "@/components/field";
import { api } from "@/lib/api";

export interface Delivery {
  id: string;
  approvalId: string;
  kind: "pull_request" | "branch";
  status: "awaiting_approval" | "queued" | "running" | "done" | "failed" | "denied";
  repo: { url: string; base: string | null };
  branch: string;
  commit: string;
  title: string;
  url: string | null;
  number: number | null;
  error: string | null;
}

const TONE = {
  awaiting_approval: "warning",
  queued: "info",
  running: "running",
  done: "success",
  failed: "danger",
  denied: "muted",
} as const;

/** Handing the work back: the branch and pull request a finished mission proposes, approved here (CLAUDE.md rule 6). */
export function DeliveryPanel({
  missionId,
  deliveries,
  missionDone,
}: {
  missionId: string;
  deliveries: Delivery[];
  missionDone: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const d = deliveries.at(-1);
  if (!d) return null;

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const decide = (decision: "approve" | "deny") =>
    act(decision, () => api(`/v1/approvals/${d.approvalId}/decide`, { method: "POST", body: { decision } }));
  const what = d.kind === "pull_request" ? "Open a pull request" : "Push a branch";

  return (
    <section
      aria-labelledby="delivery-title"
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
      data-testid="delivery"
      data-status={d.status}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="delivery-title" className="text-sm font-semibold">
          {what}
        </h2>
        <Chip tone={TONE[d.status]}>{d.status.replaceAll("_", " ")}</Chip>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 font-mono text-xs">
        <dt className="text-fg-subtle">repo</dt>
        <dd className="truncate">{d.repo.url}</dd>
        <dt className="text-fg-subtle">branch</dt>
        <dd className="truncate">
          {d.branch}
          {d.repo.base ? ` → ${d.repo.base}` : ""}
        </dd>
        <dt className="text-fg-subtle">commit</dt>
        <dd>{d.commit.slice(0, 12)}</dd>
      </dl>
      {d.status === "awaiting_approval" && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="mr-auto text-xs text-fg-muted">
            Nothing reaches the repository until you approve. The push uses the project&apos;s git token.
          </p>
          <Button variant="ghost" disabled={busy !== null} onClick={() => decide("deny")}>
            Deny
          </Button>
          <Button variant="primary" disabled={busy !== null} onClick={() => decide("approve")}>
            Approve and {d.kind === "pull_request" ? "open the pull request" : "push"}
          </Button>
        </div>
      )}
      {d.status === "done" && d.url && (
        <a href={d.url} className="text-sm text-focus hover:underline" target="_blank" rel="noreferrer">
          Pull request #{d.number}
        </a>
      )}
      {d.status === "failed" && d.error && <p className="font-mono text-xs text-danger">{d.error}</p>}
      {missionDone && (d.status === "failed" || d.status === "denied") && (
        <div>
          <Button
            variant="ghost"
            disabled={busy !== null}
            onClick={() =>
              act("again", () => api(`/v1/missions/${missionId}/deliveries`, { method: "POST" }))
            }
          >
            Ask again
          </Button>
        </div>
      )}
      <FormError>{error}</FormError>
    </section>
  );
}
