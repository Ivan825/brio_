import { describe, expect, it } from "vitest";
import { layoutPlan, NODE } from "../lib/plan-layout";

describe("plan layout", () => {
  it("puts each task one column after its longest chain of dependencies, in plan order within a column", () => {
    const { nodes, edges, width, height } = layoutPlan([
      { key: "contract", dependsOn: [] },
      { key: "api", dependsOn: ["contract"] },
      { key: "web", dependsOn: ["contract"] },
      { key: "e2e", dependsOn: ["api", "web", "contract"] },
      { key: "docs", dependsOn: [] },
    ]);
    const at = Object.fromEntries(nodes.map((n) => [n.key, [n.column, n.row]]));
    expect(at).toEqual({ contract: [0, 0], api: [1, 0], web: [1, 1], e2e: [2, 0], docs: [0, 1] });
    expect(edges.map((e) => `${e.from}>${e.to}`)).toEqual([
      "contract>api",
      "contract>web",
      "api>e2e",
      "web>e2e",
      "contract>e2e",
    ]);
    expect(edges[0]?.d).toMatch(/^M 200 28 C /);
    expect(width).toBe(3 * NODE.w + 2 * NODE.gapX);
    expect(height).toBe(2 * NODE.h + NODE.gapY);
  });

  it("survives a cycle and dependencies on missing tasks", () => {
    const { nodes } = layoutPlan([
      { key: "a", dependsOn: ["b", "ghost"] },
      { key: "b", dependsOn: ["a"] },
    ]);
    expect(nodes).toHaveLength(2);
  });
});
