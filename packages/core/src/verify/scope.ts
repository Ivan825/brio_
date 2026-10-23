// The diff_scope check (ROUTING §4.1): every changed file lies inside the task's expected footprint. Pure.
import { patternsOverlap } from "../leases/overlap";

export interface ScopeResult {
  passed: boolean;
  outside: string[];
  summary: string;
}

/** Whether a concrete file path falls under a footprint entry (a file, a directory, or a glob). */
export function inFootprint(file: string, footprint: readonly string[]): boolean {
  return footprint.some((p) => patternsOverlap(file, p));
}

export function diffScope(changed: readonly string[], footprint: readonly string[] | undefined): ScopeResult {
  if (changed.length === 0) return { passed: true, outside: [], summary: "no files changed" };
  if (!footprint?.length)
    return {
      passed: true,
      outside: [],
      summary: `${changed.length} file(s) changed; the task declared no footprint`,
    };
  const outside = changed.filter((f) => !inFootprint(f, footprint));
  return outside.length
    ? {
        passed: false,
        outside,
        summary: `${outside.length} file(s) outside the expected footprint: ${outside.slice(0, 10).join(", ")}`,
      }
    : {
        passed: true,
        outside: [],
        summary: `${changed.length} file(s) changed, all inside the expected footprint`,
      };
}
