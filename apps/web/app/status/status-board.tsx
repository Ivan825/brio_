"use client";

import { useEffect, useState } from "react";
import { Chip } from "@/components/chip";

type Health = "operational" | "degraded" | "down";
interface Status {
  status: Health;
  checkedAt: string;
  components: Array<{ name: string; status: Health; note: string }>;
}

const TONE = { operational: "success", degraded: "warning", down: "danger" } as const;
const SAID = { operational: "All working", degraded: "Working, with problems", down: "Not working" } as const;

export function StatusBoard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/v1/status", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<Status>) : Promise.reject(new Error(String(r.status)))))
        .then((s) => {
          if (!live) return;
          setStatus(s);
          setUnreachable(false);
        })
        .catch(() => live && setUnreachable(true));
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  if (unreachable)
    return (
      <p
        role="status"
        className="rounded-md border border-line bg-surface px-4 py-3 text-danger"
        data-testid="status"
      >
        The API is not answering.
      </p>
    );
  if (!status) return <p className="text-fg-muted">Checking…</p>;
  return (
    <div className="flex flex-col gap-4" data-testid="status">
      <p role="status" className="flex items-center gap-2 rounded-md border border-line bg-surface px-4 py-3">
        <Chip tone={TONE[status.status]}>{status.status}</Chip>
        <span className="font-medium">{SAID[status.status]}</span>
      </p>
      <ul className="divide-y divide-line rounded-md border border-line">
        {status.components.map((c) => (
          <li
            key={c.name}
            className="flex items-center gap-3 px-4 py-2.5 text-sm"
            data-testid="status-component"
          >
            <span className="flex-1">{c.name}</span>
            <span className="text-xs text-fg-muted">{c.note}</span>
            <Chip tone={TONE[c.status]}>{c.status}</Chip>
          </li>
        ))}
      </ul>
      <p className="font-mono text-2xs text-fg-subtle">
        checked {new Date(status.checkedAt).toLocaleTimeString()}
      </p>
    </div>
  );
}
