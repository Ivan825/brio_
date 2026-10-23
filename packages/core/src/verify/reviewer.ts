// Who reviews a result (ROUTING §4.2): an agent from a different vendor than the maker, always. When the workspace has
// no such agent the check goes to a person; the maker's own vendor never grades its work. Pure.

export interface ReviewerCandidate {
  id: string;
  name: string;
  vendor: string;
  runnable: boolean;
  healthy: boolean;
  /** Task types the agent can take (from the registry); reviewers need the review or judge kinds. */
  taskTypes: readonly string[];
  local?: boolean;
}

export type ReviewerChoice =
  | { ok: true; agentId: string; name: string; vendor: string }
  | { ok: false; reason: string };

/**
 * The first suitable candidate in the caller's order (best first). `kind` is the reviewing task type, e.g.
 * `review.rubric`; confidential work is only reviewed by local models.
 */
export function pickReviewer(
  candidates: readonly ReviewerCandidate[],
  maker: { agentId: string; vendor: string },
  opts: { kind?: string; confidential?: boolean } = {},
): ReviewerChoice {
  const kind = opts.kind ?? "review.rubric";
  const able = candidates.filter(
    (c) =>
      c.runnable &&
      c.healthy &&
      c.id !== maker.agentId &&
      c.taskTypes.includes(kind) &&
      (!opts.confidential || c.local === true),
  );
  const other = able.find((c) => c.vendor !== maker.vendor);
  if (other) return { ok: true, agentId: other.id, name: other.name, vendor: other.vendor };
  if (able.length)
    return {
      ok: false,
      reason: `every agent that can review is from ${maker.vendor}, the maker's vendor; a person reviews instead`,
    };
  return { ok: false, reason: "no agent can review this; a person reviews instead" };
}
