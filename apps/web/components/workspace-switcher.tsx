"use client";

import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { WorkspaceSummary } from "@/lib/server-api";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { FormError, Input } from "./field";

export function WorkspaceSwitcher({ workspaces }: { workspaces: WorkspaceSummary[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = workspaces.find((w) => w.active);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  async function activate(id: string) {
    setBusy(true);
    try {
      await api(`/v1/workspaces/${id}/activate`, { method: "POST" });
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/v1/workspaces", { method: "POST", body: { name } });
      setName("");
      setCreating(false);
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="ghost"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Switch workspace"
        onClick={() => setOpen((o) => !o)}
        className="max-w-48 font-mono text-xs text-fg"
        data-testid="workspace-switcher"
      >
        <span className="truncate">{active ? active.name : "no workspace"}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-9 z-50 w-64 rounded-md border border-line bg-surface p-1 shadow-pop"
        >
          <p className="px-2 py-1.5 font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
            Workspaces
          </p>
          {workspaces.map((w) => (
            <button
              key={w.id}
              type="button"
              role="menuitemradio"
              aria-checked={w.active}
              disabled={busy}
              onClick={() => activate(w.id)}
              className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm text-fg hover:bg-surface-2"
            >
              <Check
                className={cn("h-3.5 w-3.5", w.active ? "text-accent" : "invisible")}
                aria-hidden="true"
              />
              <span className="flex-1 truncate">{w.name}</span>
              <span className="font-mono text-2xs text-fg-subtle">{w.role}</span>
            </button>
          ))}
          <div className="my-1 border-t border-line" />
          {creating ? (
            <form onSubmit={create} className="flex flex-col gap-2 p-2">
              <Input
                autoFocus
                placeholder="Workspace name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-label="Workspace name"
              />
              <FormError>{error}</FormError>
              <Button type="submit" variant="primary" size="sm" disabled={busy || !name.trim()}>
                Create workspace
              </Button>
            </form>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => setCreating(true)}
              className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm text-fg-muted hover:bg-surface-2 hover:text-fg"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              New workspace
            </button>
          )}
        </div>
      )}
    </div>
  );
}
