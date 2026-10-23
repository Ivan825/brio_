"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { Chip } from "@/components/chip";
import { FormError, Textarea } from "@/components/field";
import { api } from "@/lib/api";

export type InboxItem =
  | { kind: "plan"; missionId: string; mission: string; version: number; at: string }
  | {
      kind: "review";
      missionId: string;
      mission: string;
      taskId: string;
      taskKey: string;
      title: string;
      checks: Array<{ kind: string; summary: string | null }>;
      at: string;
    }
  | {
      kind: "question" | "blocker" | "review_request";
      missionId: string;
      mission: string;
      messageId: string;
      body: string;
      at: string;
    }
  | {
      kind: "action";
      missionId: string | null;
      mission: string | null;
      approvalId: string;
      action: string;
      requestedBy: string;
      at: string;
    };

const LABEL: Record<InboxItem["kind"], string> = {
  plan: "plan to approve",
  review: "result to review",
  question: "question",
  blocker: "blocker",
  review_request: "review requested",
  action: "action to approve",
};

const ACTION_TEXT: Record<string, string> = {
  open_pull_request: "Open a pull request with the mission's integrated changes",
  push_branch: "Push the mission's integrated changes to a new branch",
};

function keyOf(i: InboxItem) {
  return i.kind === "plan"
    ? `plan-${i.missionId}-${i.version}`
    : i.kind === "review"
      ? `review-${i.taskId}`
      : i.kind === "action"
        ? `action-${i.approvalId}`
        : `msg-${i.messageId}`;
}

function Item({ item }: { item: InboxItem }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-line bg-surface p-4"
      data-testid="inbox-item"
      data-kind={item.kind}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={item.kind === "blocker" ? "danger" : item.kind === "action" ? "warning" : "info"}>
          {LABEL[item.kind]}
        </Chip>
        {item.missionId && (
          <Link href={`/missions/${item.missionId}`} className="truncate text-sm text-focus hover:underline">
            {item.mission}
          </Link>
        )}
        <span className="ml-auto font-mono text-2xs text-fg-subtle">
          {new Date(item.at).toLocaleString()}
        </span>
      </div>
      {item.kind === "plan" && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() =>
              void act(() =>
                api(`/v1/missions/${item.missionId}/plans/${item.version}/approve`, { method: "POST" }),
              )
            }
          >
            Approve plan v{item.version}
          </Button>
          <Link
            href={`/missions/${item.missionId}`}
            className="self-center text-xs text-focus hover:underline"
          >
            Review it first
          </Link>
        </div>
      )}
      {item.kind === "review" && (
        <>
          <p className="text-sm">
            <span className="font-mono">{item.taskKey}</span> · {item.title}
          </p>
          <ul className="text-xs text-fg-muted">
            {item.checks.map((c) => (
              <li key={`${c.kind}:${c.summary ?? ""}`}>
                {c.kind}
                {c.summary ? `: ${c.summary}` : ""}
              </li>
            ))}
          </ul>
          <Textarea
            aria-label="Reasons"
            rows={2}
            placeholder="Reasons (sent back to the agent when you ask for changes)"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex gap-2">
            {(["pass", "revise", "fail"] as const).map((verdict) => (
              <Button
                key={verdict}
                size="sm"
                variant={verdict === "pass" ? "primary" : "ghost"}
                disabled={busy || (verdict !== "pass" && !text.trim())}
                onClick={() =>
                  void act(() =>
                    api(`/v1/tasks/${item.taskId}/review`, {
                      method: "POST",
                      body: { verdict, reasons: text },
                    }),
                  )
                }
              >
                {verdict === "pass" ? "Accept" : verdict === "revise" ? "Send back" : "Fail"}
              </Button>
            ))}
          </div>
        </>
      )}
      {(item.kind === "question" || item.kind === "blocker" || item.kind === "review_request") && (
        <>
          <p className="whitespace-pre-wrap text-sm">{item.body}</p>
          <Textarea
            aria-label="Your answer"
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div>
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !text.trim()}
              onClick={() =>
                void act(() =>
                  api(`/v1/messages/${item.messageId}/answer`, { method: "POST", body: { text } }),
                )
              }
            >
              {item.kind === "question" ? "Answer" : "Reply and close"}
            </Button>
          </div>
        </>
      )}
      {item.kind === "action" && (
        <>
          <p className="text-sm">{ACTION_TEXT[item.action] ?? item.action}</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  api(`/v1/approvals/${item.approvalId}/decide`, { method: "POST", body: { approve: true } }),
                )
              }
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  api(`/v1/approvals/${item.approvalId}/decide`, {
                    method: "POST",
                    body: { approve: false },
                  }),
                )
              }
            >
              Deny
            </Button>
          </div>
        </>
      )}
      <FormError>{error}</FormError>
    </li>
  );
}

export function InboxList({ items }: { items: InboxItem[] }) {
  return (
    <ul className="flex flex-col gap-3" aria-label="Waiting for you">
      {items.map((i) => (
        <Item key={keyOf(i)} item={i} />
      ))}
    </ul>
  );
}
