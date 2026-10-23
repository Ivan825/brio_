// Handoff packets (docs/HANDOFF_PACKET.md), built from a finished task for each task that depends on it. Pure: the
// orchestrator supplies the facts. Sections the agent wrote in its answer (Decisions, Risks, Next steps, Open
// questions) are carried over; the packet is always marked untrusted content.
import type { HandoffPacket } from "@brio/schema";

export interface HandoffInput {
  id: string;
  createdAt: string;
  mission: { id: string; title: string; goal: string };
  from: { taskKey: string; agentKey: string; vendor: string; summary: string; output: string };
  to: { taskKey: string; objective: string; agentKey?: string };
  artifacts: Array<{ kind: string; ref: string; sha256?: string; note?: string }>;
  contracts: Array<{ name: string; version: string; ref: string }>;
  checks: Array<{ kind: string; passed: boolean; summary: string; ref: string }>;
  constraints: string[];
  /** Decisions the sender itself received in handoffs: settled decisions travel down the whole chain. */
  inheritedDecisions?: Array<{ statement: string; rationale?: string }>;
}

/** Bullet lines under a markdown heading whose text matches `title` (any level, case-insensitive). */
export function section(markdown: string, title: RegExp): string[] {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line) ?? /^\s*\*\*(.+?)\*\*:?\s*$/.exec(line);
    if (heading) {
      inside = title.test(heading[2] ?? heading[1] ?? "");
      continue;
    }
    if (!inside) continue;
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(line);
    if (item?.[1]) out.push(item[1]);
  }
  return out.slice(0, 20);
}

export function buildHandoff(i: HandoffInput): HandoffPacket {
  const own: Array<{ statement: string; rationale?: string }> = section(i.from.output, /^decisions?\b/i).map(
    (statement) => ({ statement }),
  );
  const seen = new Set<string>();
  const decisions = [...(i.inheritedDecisions ?? []), ...own]
    .filter((d) => !seen.has(d.statement) && seen.add(d.statement))
    .map((d, n) => ({
      id: `D${n + 1}`,
      statement: d.statement,
      ...(d.rationale ? { rationale: d.rationale } : {}),
    }));
  const done = section(i.from.output, /^(done|changes|what i did|summary)\b/i);
  return {
    version: "1",
    id: i.id,
    mission: i.mission,
    from: { taskKey: i.from.taskKey, agentKey: i.from.agentKey, vendor: i.from.vendor },
    to: { taskKey: i.to.taskKey, ...(i.to.agentKey ? { agentKey: i.to.agentKey } : {}) },
    objective: i.to.objective,
    done: done.length ? done : i.from.summary ? [i.from.summary] : [],
    decisions,
    openQuestions: section(i.from.output, /^open questions?\b/i).map((question) => ({
      question,
      askWho: "sender" as const,
    })),
    contracts: i.contracts,
    artifacts: i.artifacts,
    constraints: i.constraints,
    evidence: i.checks.map((c) => ({
      kind: "test" as const,
      ref: c.ref,
      summary: `${c.kind} ${c.passed ? "passed" : "failed"}: ${c.summary}`,
    })),
    risks: section(i.from.output, /^risks?\b/i),
    nextSteps: section(i.from.output, /^next steps?\b/i),
    trust: "untrusted-content",
    createdAt: i.createdAt,
  };
}
