"use client";

import { layoutPlan, NODE } from "@/lib/plan-layout";
import { cn } from "@/lib/utils";

export interface GraphTask {
  key: string;
  type: string;
  title: string;
  dependsOn: string[];
  /** A status colours the node on the board; plans have none. */
  status?: string;
}

const STATUS_TONE: Record<string, string> = {
  done: "text-success",
  failed: "text-danger",
  running: "text-running",
  verifying: "text-info",
  blocked: "text-warning",
};

/** The plan as a left-to-right graph of tasks; click a task to select it. */
export function PlanGraph({
  tasks,
  selected,
  onSelect,
  label = "Plan graph",
}: {
  tasks: GraphTask[];
  selected?: string | null;
  onSelect?: (key: string) => void;
  label?: string;
}) {
  const { nodes, edges, width, height } = layoutPlan(tasks);
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const pad = 8;
  return (
    <div className="overflow-auto rounded-md border border-line bg-bg p-2" data-testid="plan-graph">
      <svg
        role="img"
        aria-label={label}
        width={width + pad * 2}
        height={height + pad * 2}
        viewBox={`${-pad} ${-pad} ${width + pad * 2} ${height + pad * 2}`}
        className="font-sans"
      >
        <g className="text-line-strong">
          {edges.map((e) => (
            <path key={`${e.from}>${e.to}`} d={e.d} fill="none" stroke="currentColor" strokeWidth={1.25} />
          ))}
        </g>
        {nodes.map((n) => {
          const t = byKey.get(n.key);
          if (!t) return null;
          const on = selected === n.key;
          return (
            // biome-ignore lint/a11y/useSemanticElements: an SVG node cannot be a <button>; it has the role and keys
            <g
              key={n.key}
              transform={`translate(${n.x} ${n.y})`}
              role="button"
              tabIndex={0}
              aria-pressed={on}
              aria-label={`${t.title} (${t.key})`}
              data-testid="graph-node"
              data-key={n.key}
              className={cn("cursor-pointer outline-none", on ? "text-focus" : "text-line")}
              onClick={() => onSelect?.(n.key)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onSelect?.(n.key);
              }}
            >
              <rect
                width={NODE.w}
                height={NODE.h}
                rx={6}
                className="fill-surface"
                stroke="currentColor"
                strokeWidth={on ? 2 : 1}
              />
              {t.status && (
                <circle
                  cx={NODE.w - 12}
                  cy={12}
                  r={4}
                  className={STATUS_TONE[t.status] ?? "text-fg-subtle"}
                  fill="currentColor"
                />
              )}
              <text x={10} y={22} className="fill-fg text-xs">
                {t.title.length > 26 ? `${t.title.slice(0, 25)}…` : t.title}
              </text>
              <text x={10} y={42} className="fill-fg-subtle font-mono text-2xs">
                {t.key.length > 30 ? `${t.key.slice(0, 29)}…` : t.key}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
