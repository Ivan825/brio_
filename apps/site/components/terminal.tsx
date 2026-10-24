"use client";

import { useState } from "react";
import { CopyButton } from "@/components/copy";

/** Commands for each place Brio can run, one tab each. */
export function Terminal({ tabs }: { tabs: ReadonlyArray<{ label: string; commands: readonly string[] }> }) {
  const [active, setActive] = useState(0);
  const tab = tabs[active] ?? tabs[0];
  if (!tab) return null;
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-line px-2 py-1.5">
        <div role="tablist" aria-label="Where to run it" className="flex gap-1">
          {tabs.map((t, i) => (
            <button
              key={t.label}
              type="button"
              role="tab"
              aria-selected={i === active}
              onClick={() => setActive(i)}
              className={`rounded-sm px-2 py-1 font-mono text-2xs transition-colors duration-fast ${i === active ? "bg-surface-2 text-fg" : "text-fg-muted hover:text-fg"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <CopyButton text={tab.commands.join("\n")} label="Copy all" />
      </div>
      <ol role="tabpanel" className="space-y-2 p-4 font-mono text-xs sm:text-sm">
        {tab.commands.map((cmd) => (
          <li key={cmd} className="flex gap-2 break-all">
            <span className="select-none text-accent">$</span>
            <span className="text-fg">{cmd}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
