// Lays a plan out as a left-to-right graph: a task's column is the length of the longest chain of tasks before it, and
// within a column tasks keep their plan order. Pure, so the board, the plan editor and tests share it.

export interface LayoutInput {
  key: string;
  dependsOn: string[];
}

export interface LayoutNode {
  key: string;
  column: number;
  row: number;
  x: number;
  y: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
  /** An SVG path from the right edge of `from` to the left edge of `to`. */
  d: string;
}

export const NODE = { w: 200, h: 56, gapX: 56, gapY: 16 } as const;

export function layoutPlan(tasks: LayoutInput[]): {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
} {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const column = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (key: string): number => {
    const known = column.get(key);
    if (known !== undefined) return known;
    // A cycle (lint refuses those, but a draft may have one) is cut where it is found.
    if (visiting.has(key)) return 0;
    visiting.add(key);
    const deps = (byKey.get(key)?.dependsOn ?? []).filter((d) => byKey.has(d));
    const c = deps.length ? Math.max(...deps.map(depth)) + 1 : 0;
    visiting.delete(key);
    column.set(key, c);
    return c;
  };
  for (const t of tasks) depth(t.key);

  const rows = new Map<number, number>();
  const nodes: LayoutNode[] = tasks.map((t) => {
    const c = column.get(t.key) ?? 0;
    const r = rows.get(c) ?? 0;
    rows.set(c, r + 1);
    return { key: t.key, column: c, row: r, x: c * (NODE.w + NODE.gapX), y: r * (NODE.h + NODE.gapY) };
  });
  const at = new Map(nodes.map((n) => [n.key, n]));
  const edges: LayoutEdge[] = [];
  for (const t of tasks)
    for (const d of t.dependsOn) {
      const a = at.get(d);
      const b = at.get(t.key);
      if (!a || !b) continue;
      const x1 = a.x + NODE.w;
      const y1 = a.y + NODE.h / 2;
      const x2 = b.x;
      const y2 = b.y + NODE.h / 2;
      const mid = (x1 + x2) / 2;
      edges.push({ from: d, to: t.key, d: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}` });
    }
  const columns = Math.max(0, ...nodes.map((n) => n.column)) + 1;
  const maxRows = Math.max(0, ...rows.values());
  return {
    nodes,
    edges,
    width: columns * NODE.w + (columns - 1) * NODE.gapX,
    height: maxRows * NODE.h + Math.max(0, maxRows - 1) * NODE.gapY,
  };
}
