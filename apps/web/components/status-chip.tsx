import { cn } from "@/lib/utils";

const TONE: Record<string, string> = {
  draft: "text-fg-muted",
  planning: "text-running",
  running: "text-running",
  verifying: "text-running",
  awaiting_approval: "text-info",
  done: "text-success",
  failed: "text-danger",
  cancelled: "text-fg-subtle",
  pending: "text-fg-muted",
  ready: "text-info",
};

export const RUNNING_STATUSES = new Set(["planning", "running", "verifying"]);

/** Status as a small mono chip in a status colour (never an agent colour). */
export function StatusChip({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border border-line px-1.5 py-0.5 font-mono text-2xs",
        TONE[status] ?? "text-fg-muted",
      )}
      data-status={status}
    >
      {RUNNING_STATUSES.has(status) && <span className="brio-cursor" aria-hidden="true" />}
      {status.replaceAll("_", " ")}
    </span>
  );
}
