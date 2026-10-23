"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/button";
import { FormError, Label, Textarea } from "@/components/field";
import { useRunning } from "@/components/running";
import { api } from "@/lib/api";

export function NewMission() {
  const router = useRouter();
  const { setRunning } = useRunning();
  const [goal, setGoal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setRunning("new-mission", true);
    setError(null);
    try {
      const { mission } = await api<{ mission: { id: string } }>("/v1/missions", {
        method: "POST",
        body: { goal },
      });
      router.push(`/missions/${mission.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setRunning("new-mission", false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
      <Label htmlFor="goal">New mission</Label>
      <Textarea
        id="goal"
        required
        maxLength={10_000}
        placeholder="One goal, in plain words. e.g. Add passkey sign-in to the web app, with tests and docs."
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
      />
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-2xs text-fg-subtle">
          M0: the stub planner proposes one task; agents arrive in M1–M3.
        </p>
        <Button type="submit" variant="primary" disabled={busy || !goal.trim()}>
          Plan mission
        </Button>
      </div>
      <FormError>{error}</FormError>
    </form>
  );
}
