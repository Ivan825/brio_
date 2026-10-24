"use client";

import { agentColorVar } from "@brio/brand";
import { useEffect, useState } from "react";
import { BOARD } from "@/lib/content";

const STATE_LABEL = { done: "done", running: "running", waiting: "waiting" } as const;
const STATE_COLOR = {
  done: "var(--success)",
  running: "var(--running)",
  waiting: "var(--text-subtle)",
} as const;

/** A mission's board as it runs: one lane per agent, and the event stream below, one line at a time. */
export function Board() {
  const [shown, setShown] = useState<number>(BOARD.events.length);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setShown(1);
    const timer = setInterval(() => {
      setShown((n) => (n >= BOARD.events.length + 3 ? 1 : n + 1));
    }, 1100);
    return () => clearInterval(timer);
  }, []);

  const done = shown >= BOARD.events.length;
  return (
    <figure
      className="overflow-hidden rounded-lg border border-line bg-surface"
      aria-label="A mission's live board: three agents, their tasks and the event stream"
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-2">
        <span className="font-mono text-xs text-fg-muted">~/acme-api · mission “add a /health endpoint”</span>
        <span className="font-mono text-2xs text-fg-subtle">{done ? "done" : "live"}</span>
      </div>
      <div className="grid grid-cols-1 gap-px bg-line sm:grid-cols-3">
        {BOARD.lanes.map((lane, i) => {
          const state = done ? "done" : lane.state;
          return (
            <div key={lane.agent} className="bg-surface p-3">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-xs" style={{ background: agentColorVar(i) }} aria-hidden />
                <span className="font-mono text-xs text-fg">{lane.agent}</span>
              </div>
              <div className="mt-2 rounded-sm border border-line bg-surface-2 p-2">
                <div className="font-mono text-2xs text-fg-muted">{lane.task}</div>
                <div className="mt-1 font-mono text-2xs" style={{ color: STATE_COLOR[state] }}>
                  {STATE_LABEL[state]}
                  {state === "running" ? <span className="brio-cursor" aria-hidden /> : null}
                </div>
                {state === "running" ? (
                  <div className="mt-2 h-px w-full overflow-hidden bg-line">
                    <div className="h-px w-2/3 bg-running" />
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <ol className="min-h-[188px] space-y-1 border-t border-line bg-bg px-4 py-3 font-mono text-2xs sm:text-xs">
        {BOARD.events.slice(0, Math.min(shown, BOARD.events.length)).map((line) => {
          const [who, what] = line.split(" → ");
          return (
            <li key={line} className="board-line truncate">
              <span className="text-fg">{who}</span>
              <span className="text-fg-subtle"> → </span>
              <span className="text-fg-muted">{what}</span>
            </li>
          );
        })}
      </ol>
    </figure>
  );
}
