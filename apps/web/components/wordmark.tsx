"use client";

import { BRAND } from "@brio/brand";
import { cn } from "@/lib/utils";
import { useRunning } from "./running";

/** The `brio_` wordmark as live text. The brass cursor blinks while anything is running and is solid otherwise. */
export function Wordmark({ className }: { className?: string }) {
  const { running } = useRunning();
  return (
    <span className={cn("inline-flex items-baseline font-mono font-bold tracking-tight text-fg", className)}>
      <span className="sr-only">{BRAND.name}</span>
      <span aria-hidden="true">{BRAND.wordmark}</span>
      <span
        aria-hidden="true"
        className="brio-cursor"
        data-testid="brio-cursor"
        data-state={running ? "running" : "idle"}
      />
    </span>
  );
}
