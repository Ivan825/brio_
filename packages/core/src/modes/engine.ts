// Execution modes (ROUTING_AND_QUALITY §3.2) as a pure step function: from a task's attempts so far, what happens next.
// The orchestrator dispatches what it asks for, records results, and calls it again; the same input always gives the
// same steps, so it is safe across restarts. (Single mode is the plain attempt → checks → done flow.)
import type { Assignment, Mode, Role } from "../router/learned";

export type AttemptStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
/** The hard acceptance checks of a maker/candidate/merger attempt, summarised. */
export type CheckSummary = "pending" | "passed" | "failed" | "none";

export interface ModeAttempt {
  id: string;
  role: Role;
  agentId: string;
  status: AttemptStatus;
  checks: CheckSummary;
  /** What this attempt was for (from its dispatch): make, review, judge, merge, or a pipeline/cascade step. */
  purpose: Purpose;
  /** Attempts it reviewed, judged or merged. */
  of: string[];
  step: number;
  costUsd: number;
  /** A judge's parsed verdict: the winning attempt id, or "tie". */
  winner?: string | "tie";
  /** A checker's parsed verdict. */
  verdict?: "pass" | "revise" | "fail";
  reasons?: string;
  createdAt: number;
}

export type Purpose = "make" | "revise" | "review" | "judge" | "merge";

export interface ModeState {
  mode: Exclude<Mode, "single">;
  agents: Assignment[];
  attempts: ModeAttempt[];
  maxRevisions: number;
}

export type ModeAction =
  | {
      kind: "dispatch";
      role: Role;
      agentId: string;
      purpose: Purpose;
      /** Attempts to review, judge (in this order: A then B) or merge. */
      of: string[];
      step: number;
      feedback?: string;
    }
  | { kind: "accept"; attemptId: string; note: string }
  | { kind: "fail"; reason: string }
  | { kind: "judged"; winner: string; loser: string | null; tie: boolean };

const done = (a: ModeAttempt) => a.status !== "queued" && a.status !== "running";
const ok = (a: ModeAttempt) => a.status === "succeeded";
/** A made result counts once its hard checks are settled; "none" (no automatic checks) counts as passing. */
const settled = (a: ModeAttempt) => done(a) && (!ok(a) || a.checks !== "pending");
const good = (a: ModeAttempt) => ok(a) && (a.checks === "passed" || a.checks === "none");
const byRole = (s: ModeState, role: Role) => s.agents.filter((x) => x.role === role);
const of = (s: ModeState, p: Purpose) => s.attempts.filter((a) => a.purpose === p);
const forAgent = (as: ModeAttempt[], agentId: string) => as.filter((a) => a.agentId === agentId);

/** Pairwise judging in both orders cancels position bias (§4.3); disagreement is a tie. */
function judge(
  s: ModeState,
  a: ModeAttempt,
  b: ModeAttempt,
): ModeAction[] | { winner: ModeAttempt; loser: ModeAttempt | null; tie: boolean } {
  const judgeAgent = byRole(s, "judge")[0] ?? byRole(s, "merger")[0];
  if (!judgeAgent) {
    // No judge available: the cheaper of two passing results wins.
    const [w, l] = a.costUsd <= b.costUsd ? [a, b] : [b, a];
    return { winner: w, loser: l, tie: true };
  }
  const judgments = of(s, "judge").filter((j) => j.of.includes(a.id) && j.of.includes(b.id));
  const order = (x: string, y: string) => judgments.find((j) => j.of[0] === x && j.of[1] === y);
  const ab = order(a.id, b.id);
  const ba = order(b.id, a.id);
  const out: ModeAction[] = [];
  if (!ab)
    out.push({
      kind: "dispatch",
      role: "judge",
      agentId: judgeAgent.agentId,
      purpose: "judge",
      of: [a.id, b.id],
      step: 0,
    });
  if (!ba)
    out.push({
      kind: "dispatch",
      role: "judge",
      agentId: judgeAgent.agentId,
      purpose: "judge",
      of: [b.id, a.id],
      step: 0,
    });
  if (out.length) return out;
  if (!ab || !ba || !done(ab) || !done(ba)) return [];
  const w1 = ok(ab) ? ab.winner : undefined;
  const w2 = ok(ba) ? ba.winner : undefined;
  if (w1 && w1 === w2 && w1 !== "tie") {
    const winner = w1 === a.id ? a : b;
    return { winner, loser: winner === a ? b : a, tie: false };
  }
  // Disagreement, ties or a failed judge: tests already passed for both, so the cheaper one wins.
  const [w, l] = a.costUsd <= b.costUsd ? [a, b] : [b, a];
  return { winner: w, loser: l, tie: true };
}

export function nextStep(s: ModeState): ModeAction[] {
  switch (s.mode) {
    case "best_of_n": {
      const candidates = byRole(s, "candidate");
      const missing = candidates.filter((c) => forAgent(of(s, "make"), c.agentId).length === 0);
      if (missing.length)
        return missing.map((c) => ({
          kind: "dispatch",
          role: "candidate",
          agentId: c.agentId,
          purpose: "make",
          of: [],
          step: 0,
        }));
      const made = of(s, "make");
      if (!made.every(settled)) return [];
      const passing = made.filter(good).sort((x, y) => x.createdAt - y.createdAt);
      if (passing.length === 0)
        return [{ kind: "fail", reason: `none of the ${made.length} candidates passed their checks` }];
      // A knockout: the first two passing results are judged, the winner meets the next.
      let champion = passing[0] as ModeAttempt;
      const out: ModeAction[] = [];
      for (const challenger of passing.slice(1)) {
        const r = judge(s, champion, challenger);
        if (Array.isArray(r)) return r;
        out.push({ kind: "judged", winner: r.winner.id, loser: r.loser?.id ?? null, tie: r.tie });
        champion = r.winner;
      }
      return [
        ...out,
        {
          kind: "accept",
          attemptId: champion.id,
          note:
            passing.length > 1
              ? `best of ${made.length}: chosen by the judge`
              : "the only candidate that passed its checks",
        },
      ];
    }

    case "ensemble": {
      const candidates = byRole(s, "candidate");
      const missing = candidates.filter((c) => forAgent(of(s, "make"), c.agentId).length === 0);
      if (missing.length)
        return missing.map((c) => ({
          kind: "dispatch",
          role: "candidate",
          agentId: c.agentId,
          purpose: "make",
          of: [],
          step: 0,
        }));
      const made = of(s, "make");
      if (!made.every(done)) return [];
      const usable = made.filter(ok);
      if (!usable.length) return [{ kind: "fail", reason: "every ensemble member failed" }];
      const merger = byRole(s, "merger")[0];
      const merges = of(s, "merge");
      if (!merger)
        return [
          { kind: "accept", attemptId: (usable[0] as ModeAttempt).id, note: "no merger: the first result" },
        ];
      const merge = merges.at(-1);
      if (!merge)
        return [
          {
            kind: "dispatch",
            role: "merger",
            agentId: merger.agentId,
            purpose: "merge",
            of: usable.map((u) => u.id),
            step: 0,
          },
        ];
      if (!settled(merge)) return [];
      if (good(merge))
        return [{ kind: "accept", attemptId: merge.id, note: `merged from ${usable.length} results` }];
      if (merges.length <= s.maxRevisions)
        return [
          {
            kind: "dispatch",
            role: "merger",
            agentId: merger.agentId,
            purpose: "merge",
            of: usable.map((u) => u.id),
            step: 0,
            feedback: "The previous merge failed its checks; merge again.",
          },
        ];
      return [{ kind: "fail", reason: "the merged result failed its checks" }];
    }

    case "maker_checker": {
      const maker = byRole(s, "maker")[0];
      const checker = byRole(s, "checker")[0];
      if (!maker || !checker) return [{ kind: "fail", reason: "maker–checker needs a maker and a checker" }];
      const makes = s.attempts
        .filter((a) => a.purpose === "make" || a.purpose === "revise")
        .sort((x, y) => x.createdAt - y.createdAt);
      const last = makes.at(-1);
      if (!last)
        return [
          { kind: "dispatch", role: "maker", agentId: maker.agentId, purpose: "make", of: [], step: 0 },
        ];
      if (!settled(last)) return [];
      const revisionsUsed = makes.length - 1;
      const revise = (feedback: string): ModeAction[] =>
        revisionsUsed < s.maxRevisions
          ? [
              {
                kind: "dispatch",
                role: "maker",
                agentId: maker.agentId,
                purpose: "revise",
                of: [last.id],
                step: revisionsUsed + 1,
                feedback,
              },
            ]
          : [{ kind: "fail", reason: `still not accepted after ${revisionsUsed} revision(s): ${feedback}` }];
      if (!good(last))
        return revise(ok(last) ? "Your result failed its checks." : "Your attempt did not finish.");
      const review = of(s, "review").find((r) => r.of[0] === last.id);
      if (!review)
        return [
          {
            kind: "dispatch",
            role: "checker",
            agentId: checker.agentId,
            purpose: "review",
            of: [last.id],
            step: 0,
          },
        ];
      if (!done(review)) return [];
      if (!ok(review))
        return [
          {
            kind: "accept",
            attemptId: last.id,
            note: "the checker could not review; accepted on its checks",
          },
        ];
      if (review.verdict === "pass")
        return [{ kind: "accept", attemptId: last.id, note: "approved by the checker" }];
      if (review.verdict === "fail")
        return [{ kind: "fail", reason: `the checker failed it: ${review.reasons ?? ""}` }];
      return revise(`The checker asked for changes: ${review.reasons ?? "no reasons given"}`);
    }

    case "debate": {
      const candidates = byRole(s, "candidate");
      const missing = candidates.filter((c) => forAgent(of(s, "make"), c.agentId).length === 0);
      if (missing.length)
        return missing.map((c) => ({
          kind: "dispatch",
          role: "candidate",
          agentId: c.agentId,
          purpose: "make",
          of: [],
          step: 0,
        }));
      const proposals = of(s, "make").sort((x, y) => x.createdAt - y.createdAt);
      if (!proposals.every(settled)) return [];
      const usable = proposals.filter(good);
      if (!usable.length) return [{ kind: "fail", reason: "no proposal passed its checks" }];
      if (usable.length === 1)
        return [
          { kind: "accept", attemptId: (usable[0] as ModeAttempt).id, note: "the only proposal that passed" },
        ];
      const r = judge(s, usable[0] as ModeAttempt, usable[1] as ModeAttempt);
      if (Array.isArray(r)) return r;
      const merger = byRole(s, "merger")[0];
      const judged: ModeAction = {
        kind: "judged",
        winner: r.winner.id,
        loser: r.loser?.id ?? null,
        tie: r.tie,
      };
      if (!merger) return [judged, { kind: "accept", attemptId: r.winner.id, note: "chosen by the judge" }];
      const merge = of(s, "merge").at(-1);
      if (!merge)
        return [
          judged,
          {
            kind: "dispatch",
            role: "merger",
            agentId: merger.agentId,
            purpose: "merge",
            of: [r.winner.id, r.loser?.id ?? r.winner.id],
            step: 0,
          },
        ];
      if (!settled(merge)) return [];
      return [
        judged,
        good(merge)
          ? { kind: "accept", attemptId: merge.id, note: "the judge picked and merged the proposals" }
          : {
              kind: "accept",
              attemptId: r.winner.id,
              note: "the merge failed its checks; the judge's pick stands",
            },
      ];
    }

    case "cascade": {
      const ladder = byRole(s, "maker");
      const tries = of(s, "make").sort((x, y) => x.step - y.step);
      const last = tries.at(-1);
      if (!last)
        return ladder[0]
          ? [
              {
                kind: "dispatch",
                role: "maker",
                agentId: ladder[0].agentId,
                purpose: "make",
                of: [],
                step: 0,
              },
            ]
          : [{ kind: "fail", reason: "empty cascade" }];
      if (!settled(last)) return [];
      if (good(last))
        return [
          {
            kind: "accept",
            attemptId: last.id,
            note: last.step ? `escalated to step ${last.step + 1}` : "the cheapest agent passed",
          },
        ];
      const next = ladder[last.step + 1];
      if (!next) return [{ kind: "fail", reason: `every step of the cascade failed (${ladder.length})` }];
      return [
        {
          kind: "dispatch",
          role: "maker",
          agentId: next.agentId,
          purpose: "make",
          of: [last.id],
          step: last.step + 1,
          feedback: "A cheaper agent's attempt failed its checks; you are the escalation.",
        },
      ];
    }

    case "pipeline": {
      const steps = byRole(s, "maker");
      const tries = of(s, "make").sort((x, y) => x.step - y.step);
      const last = tries.at(-1);
      if (!last)
        return steps[0]
          ? [{ kind: "dispatch", role: "maker", agentId: steps[0].agentId, purpose: "make", of: [], step: 0 }]
          : [{ kind: "fail", reason: "empty pipeline" }];
      if (!done(last)) return [];
      if (!ok(last)) return [{ kind: "fail", reason: `pipeline step ${last.step + 1} failed` }];
      const next = steps[last.step + 1];
      if (next)
        return [
          {
            kind: "dispatch",
            role: "maker",
            agentId: next.agentId,
            purpose: "make",
            of: [last.id],
            step: last.step + 1,
          },
        ];
      if (!settled(last)) return [];
      return good(last)
        ? [{ kind: "accept", attemptId: last.id, note: `pipeline of ${steps.length} steps` }]
        : [{ kind: "fail", reason: "the pipeline's result failed its checks" }];
    }
  }
}
