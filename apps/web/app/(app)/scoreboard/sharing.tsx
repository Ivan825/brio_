"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { FormError } from "@/components/field";
import { api } from "@/lib/api";

export interface Sharing {
  share: boolean;
  useGlobal: boolean;
}

/** The workspace's choices about the global scoreboard (D-14); owners and admins change them. */
export function SharingToggles({ initial }: { initial: Sharing }) {
  const router = useRouter();
  const [sharing, setSharing] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const save = async (next: Sharing) => {
    setError(null);
    const before = sharing;
    setSharing(next);
    try {
      await api("/v1/scoreboard/sharing", { method: "PUT", body: next });
      router.refresh();
    } catch (err) {
      setSharing(before);
      setError((err as Error).message);
    }
  };
  return (
    <fieldset className="flex flex-col gap-2 rounded-md border border-line p-4" data-testid="score-sharing">
      <legend className="px-1 font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
        global scoreboard
      </legend>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={sharing.share}
          onChange={(e) => void save({ ...sharing, share: e.target.checked })}
        />
        <span>
          Add this workspace's outcomes
          <span className="block text-fg-muted">
            Only the agent, task type and verdict, with cost and time. Nothing says which workspace they came
            from.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={sharing.useGlobal}
          onChange={(e) => void save({ ...sharing, useGlobal: e.target.checked })}
        />
        <span>
          Start new agents from the global numbers
          <span className="block text-fg-muted">
            Used only for agents this workspace has not scored yet, and only where at least 20 outcomes from
            three workspaces stand behind them. Your own scores always come first.
          </span>
        </span>
      </label>
      <FormError>{error}</FormError>
    </fieldset>
  );
}
