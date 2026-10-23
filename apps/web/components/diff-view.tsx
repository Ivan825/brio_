"use client";

import { useState } from "react";
import { type DiffFile, parseDiff } from "@/lib/diff";
import { cn } from "@/lib/utils";

const TONE = { add: "text-success", del: "text-danger", ctx: "text-fg-muted", meta: "text-info" };
const STATUS = { added: "A", deleted: "D", modified: "M", renamed: "R", binary: "B" } as const;

/** A unified diff, file by file: what changed where, with line numbers; each file opens and closes. */
export function DiffView({ text, testId = "diff" }: { text: string; testId?: string }) {
  const files = parseDiff(text);
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(files.length <= 3 ? files.map((f) => f.path) : []),
  );
  if (!files.length)
    return (
      <p className="font-mono text-xs text-fg-subtle" data-testid={testId}>
        no changes
      </p>
    );
  const toggle = (p: string) => {
    const next = new Set(open);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setOpen(next);
  };
  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <div className="mt-2 flex flex-col gap-2" data-testid={testId}>
      <p className="font-mono text-2xs text-fg-muted">
        {files.length} file{files.length === 1 ? "" : "s"} · <span className="text-success">+{adds}</span>{" "}
        <span className="text-danger">−{dels}</span>
      </p>
      {files.map((f) => (
        <File key={f.path} file={f} open={open.has(f.path)} onToggle={() => toggle(f.path)} />
      ))}
    </div>
  );
}

function File({ file: f, open, onToggle }: { file: DiffFile; open: boolean; onToggle: () => void }) {
  return (
    <div className="overflow-hidden rounded-md border border-line" data-testid="diff-file" data-path={f.path}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 bg-surface-2 px-2 py-1 text-left font-mono text-xs"
      >
        <span className="w-3 text-fg-subtle" title={f.status}>
          {STATUS[f.status]}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {f.from ? `${f.from} → ` : ""}
          {f.path}
        </span>
        <span className="text-success">+{f.additions}</span>
        <span className="text-danger">−{f.deletions}</span>
      </button>
      {open && f.status !== "binary" && (
        <div className="max-h-96 overflow-auto bg-bg">
          <table className="w-full border-collapse font-mono text-xs leading-relaxed">
            <tbody>
              {f.lines.map((l, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
                <tr key={i} className={cn(TONE[l.kind])}>
                  <td className="w-10 select-none px-1 text-right text-fg-subtle">{l.old ?? ""}</td>
                  <td className="w-10 select-none px-1 text-right text-fg-subtle">{l.new ?? ""}</td>
                  <td className="whitespace-pre px-2">
                    {l.kind === "add" ? "+" : l.kind === "del" ? "-" : l.kind === "ctx" ? " " : ""}
                    {l.text}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && f.status === "binary" && (
        <p className="px-2 py-1 font-mono text-xs text-fg-subtle">binary file</p>
      )}
    </div>
  );
}
