import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A small mono label: routes, tiers, model ids, prices. Tone uses status colours only (never agent colours). */
export function Chip({
  children,
  tone = "muted",
  className,
  title,
}: {
  children: ReactNode;
  tone?: "muted" | "info" | "success" | "warning" | "danger" | "running";
  className?: string;
  title?: string;
}) {
  const tones = {
    muted: "text-fg-muted",
    info: "text-info",
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
    running: "text-running",
  } as const;
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-sm border border-line px-1.5 py-0.5 font-mono text-2xs",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
