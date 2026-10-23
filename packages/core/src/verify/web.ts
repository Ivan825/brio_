// Reading web audits (ROUTING §4.1): axe-core results for a11y and Lighthouse reports for lighthouse. The audits run in
// a sandbox with a headless browser; this turns their JSON into a verdict. Pure.

export type Impact = "minor" | "moderate" | "serious" | "critical";
const IMPACTS: Impact[] = ["minor", "moderate", "serious", "critical"];

export interface AuditResult {
  passed: boolean;
  summary: string;
}

/**
 * axe-core JSON (one result object or the CLI's array of them): fails on any violation at or above `minImpact`
 * (default serious).
 */
export function readAxe(json: unknown, opts: { minImpact?: Impact } = {}): AuditResult {
  const runs = (Array.isArray(json) ? json : [json]) as Array<{
    violations?: Array<{ id: string; impact?: Impact | null; nodes?: unknown[] }>;
  }>;
  if (!runs.length || runs.some((r) => !r || !Array.isArray(r.violations)))
    return { passed: false, summary: "the accessibility audit produced no results" };
  const floor = IMPACTS.indexOf(opts.minImpact ?? "serious");
  const all = runs.flatMap((r) => r.violations ?? []);
  const blocking = all.filter((v) => IMPACTS.indexOf(v.impact ?? "minor") >= floor);
  if (!blocking.length)
    return {
      passed: true,
      summary: all.length
        ? `no ${opts.minImpact ?? "serious"} or worse violations (${all.length} minor)`
        : "no accessibility violations",
    };
  return {
    passed: false,
    summary: `${blocking.length} violation(s): ${blocking
      .slice(0, 8)
      .map((v) => `${v.id} (${v.impact}, ${v.nodes?.length ?? 0} element(s))`)
      .join(", ")}`,
  };
}

/** A Lighthouse JSON report: every category with a minimum (0–1) must meet it. */
export function readLighthouse(
  json: unknown,
  minimums: Record<string, number> = { performance: 0.8 },
): AuditResult {
  const cats = (json as { categories?: Record<string, { score: number | null; title?: string }> } | null)
    ?.categories;
  if (!cats) return { passed: false, summary: "the Lighthouse run produced no report" };
  const misses: string[] = [];
  const seen: string[] = [];
  for (const [key, min] of Object.entries(minimums)) {
    const score = cats[key]?.score;
    if (score === undefined || score === null) {
      misses.push(`${key}: not measured`);
      continue;
    }
    seen.push(`${key} ${Math.round(score * 100)}`);
    if (score < min) misses.push(`${key} ${Math.round(score * 100)} < ${Math.round(min * 100)}`);
  }
  return misses.length
    ? { passed: false, summary: misses.join(", ") }
    : { passed: true, summary: seen.join(", ") };
}
