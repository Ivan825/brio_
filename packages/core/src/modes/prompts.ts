// What reviewers, judges and mergers are asked, and how their answers are read. Outputs under review are untrusted
// content from other agents: they are quoted as data, never followed.
import { extractJson } from "../plan/parse";
import { untrustedBlock } from "../verify/untrusted";

const clip = (s: string, n = 30_000) => (s.length <= n ? s : `${s.slice(0, n)}\n…[truncated]`);
const block = (label: string, s: string) => untrustedBlock(`### ${label}`, clip(s));

export function reviewInstructions(
  task: { title: string; objective: string; constraints: string[] },
  result: string,
): string {
  return [
    `# Review: ${task.title}`,
    `Objective: ${task.objective}`,
    task.constraints.length ? `Constraints:\n${task.constraints.map((c) => `- ${c}`).join("\n")}` : "",
    "Another agent did this task. Review its result against the objective and constraints. Be specific.",
    block("The result", result),
    'Answer with one JSON object in a ```json fence: {"verdict":"pass"|"revise"|"fail","reasons":["..."]}. Use revise for fixable problems, fail only when the approach is wrong.',
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function judgeInstructions(task: { title: string; objective: string }, a: string, b: string): string {
  return [
    `# Judge: ${task.title}`,
    `Objective: ${task.objective}`,
    "Two agents did this task independently. Both passed their automatic checks. Decide which result better meets the objective. Judge substance, not length or style.",
    block("Result A", a),
    block("Result B", b),
    'Answer with one JSON object in a ```json fence: {"winner":"A"|"B"|"tie","reasons":"..."}.',
  ].join("\n\n");
}

export function mergeInstructions(
  task: { title: string; objective: string },
  results: string[],
  note?: string,
): string {
  return [
    `# Merge: ${task.title}`,
    `Objective: ${task.objective}`,
    note ??
      "Several agents did this task. Produce one result that keeps the best of each, resolves contradictions (say which you kept and why) and keeps every citation.",
    ...results.map((r, i) => block(`Result ${i + 1}`, r)),
  ].join("\n\n");
}

export function stepInstructions(base: string, previous: string, label: string): string {
  return `${base}\n\n${block(label, previous)}`;
}

export function parseVerdict(text: string): { verdict: "pass" | "revise" | "fail"; reasons: string } | null {
  try {
    const v = JSON.parse(extractJson(text) ?? "") as { verdict?: string; reasons?: unknown };
    if (v.verdict !== "pass" && v.verdict !== "revise" && v.verdict !== "fail") return null;
    const reasons = Array.isArray(v.reasons) ? v.reasons.map(String).join("; ") : String(v.reasons ?? "");
    return { verdict: v.verdict, reasons };
  } catch {
    return null;
  }
}

export function parseJudgment(text: string): { winner: "A" | "B" | "tie"; reasons: string } | null {
  try {
    const v = JSON.parse(extractJson(text) ?? "") as { winner?: string; reasons?: unknown };
    const w = String(v.winner ?? "").toUpperCase();
    if (w !== "A" && w !== "B" && w !== "TIE") return null;
    return { winner: w === "TIE" ? "tie" : (w as "A" | "B"), reasons: String(v.reasons ?? "") };
  } catch {
    return null;
  }
}
