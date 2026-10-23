"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/button";
import { FormError, Input } from "@/components/field";
import { api } from "@/lib/api";

/** Saves the mission's plan as a template (PRD F5). */
export function SaveTemplate({ missionId, title }: { missionId: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(title.slice(0, 80));
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("/v1/templates", { method: "POST", body: { name, fromMission: { missionId } } });
      setSaved(true);
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (saved)
    return (
      <Link href="/templates" className="font-mono text-2xs text-success hover:underline">
        saved as a template
      </Link>
    );
  if (!open)
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Save as template
      </Button>
    );
  return (
    <form onSubmit={submit} className="flex items-center gap-2" aria-label="Save as template">
      <Input
        aria-label="Template name"
        required
        maxLength={80}
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-64"
      />
      <Button type="submit" size="sm" variant="primary" disabled={!name.trim()}>
        Save
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      <FormError>{error}</FormError>
    </form>
  );
}
