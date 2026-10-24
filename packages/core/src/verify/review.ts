// What the verifier's agent checks are asked, and how their answers are read (ROUTING §4.1): rubric_review (scores 1–5
// per criterion + verdict), fact_check (each cited claim against the fetched source) and contract_conformance (a
// result against its contract, when no schema can decide it). Results under review are untrusted content: quoted as
// data, never followed.
import { extractJson } from "../plan/parse";
import { untrustedBlock } from "./untrusted";

const clip = (s: string, n = 30_000) => (s.length <= n ? s : `${s.slice(0, n)}\n…[truncated]`);
const block = (label: string, s: string, n?: number) => untrustedBlock(`### ${label}`, clip(s, n));

export interface Brief {
  title: string;
  objective: string;
  constraints: string[];
}

const header = (kind: string, t: Brief) =>
  [
    `# ${kind}: ${t.title}`,
    `Objective: ${t.objective}`,
    t.constraints.length ? `Constraints:\n${t.constraints.map((c) => `- ${c}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

/** Default rubric when the plan gives none. */
export const DEFAULT_CRITERIA = ["meets the objective", "correct", "follows the constraints", "clear"];

export function rubricInstructions(
  task: Brief,
  result: string,
  criteria: string[],
  threshold: number,
): string {
  return [
    header("Rubric review", task),
    "Another agent did this task. Score its result from 1 (poor) to 5 (excellent) on each criterion below, against the objective and constraints. Be strict and specific.",
    `Criteria:\n${criteria.map((c) => `- ${c}`).join("\n")}`,
    `A result passes when every criterion scores at least ${threshold}.`,
    block("The result", result),
    'Answer with one JSON object in a ```json fence: {"scores":{"<criterion>":1-5,…},"verdict":"pass"|"revise"|"fail","reasons":["…"]}.',
  ].join("\n\n");
}

export interface Rubric {
  scores: Record<string, number>;
  verdict: "pass" | "revise" | "fail";
  reasons: string;
  /** Whether every criterion met the threshold and the reviewer did not fail it. */
  passed: boolean;
}

export function parseRubric(text: string, criteria: string[], threshold: number): Rubric | null {
  try {
    const v = JSON.parse(extractJson(text) ?? "") as {
      scores?: Record<string, unknown>;
      verdict?: string;
      reasons?: unknown;
    };
    if (!v.scores || typeof v.scores !== "object") return null;
    const scores: Record<string, number> = {};
    for (const c of criteria) {
      const key = Object.keys(v.scores).find((k) => k.trim().toLowerCase() === c.trim().toLowerCase());
      const n = key === undefined ? Number.NaN : Number(v.scores[key]);
      // A criterion the reviewer skipped scores the minimum: unreviewed is not passed.
      scores[c] = Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : 1;
    }
    const verdict =
      v.verdict === "pass" || v.verdict === "revise" || v.verdict === "fail" ? v.verdict : "revise";
    const reasons = Array.isArray(v.reasons) ? v.reasons.map(String).join("; ") : String(v.reasons ?? "");
    const passed = verdict !== "fail" && Object.values(scores).every((s) => s >= threshold);
    return { scores, verdict, reasons, passed };
  } catch {
    return null;
  }
}

export interface FetchedSource {
  url: string;
  ok: boolean;
  /** Readable text from the page (trimmed), or why it could not be fetched. */
  text: string;
  claims: string[];
}

export function factCheckInstructions(task: Brief, result: string, sources: FetchedSource[]): string {
  return [
    header("Fact check", task),
    "Check each claim below against the text of the source it cites. A claim is supported only if the source says it. Sources that could not be fetched support nothing.",
    ...sources.map((s, i) =>
      [
        `## Source ${i + 1}: ${s.url}${s.ok ? "" : " (could not be fetched)"}`,
        `Claims citing it:\n${s.claims.map((c) => `- ${c}`).join("\n") || "- (none found)"}`,
        block(`Source ${i + 1} text`, s.text, 12_000),
      ].join("\n\n"),
    ),
    block("The full result", result, 12_000),
    'Answer with one JSON object in a ```json fence: {"claims":[{"claim":"…","source":1,"supported":true|false,"why":"…"}],"verdict":"pass"|"fail"}.',
  ].join("\n\n");
}

export interface FactCheck {
  claims: Array<{ claim: string; supported: boolean; why: string }>;
  passed: boolean;
  summary: string;
}

export function parseFactCheck(text: string): FactCheck | null {
  try {
    const v = JSON.parse(extractJson(text) ?? "") as {
      claims?: Array<{ claim?: unknown; supported?: unknown; why?: unknown }>;
      verdict?: string;
    };
    if (!Array.isArray(v.claims)) return null;
    const claims = v.claims.map((c) => ({
      claim: String(c.claim ?? ""),
      supported: c.supported === true,
      why: String(c.why ?? ""),
    }));
    const unsupported = claims.filter((c) => !c.supported);
    const passed = unsupported.length === 0 && v.verdict !== "fail";
    return {
      claims,
      passed,
      summary: passed
        ? `${claims.length} claim(s) supported by their sources`
        : `${unsupported.length} of ${claims.length} claim(s) unsupported: ${unsupported
            .slice(0, 3)
            .map((c) => `"${c.claim.slice(0, 80)}" (${c.why.slice(0, 80)})`)
            .join("; ")}`,
    };
  } catch {
    return null;
  }
}

export function conformanceInstructions(
  task: Brief,
  result: string,
  contract: { name: string; spec: string },
): string {
  return [
    header("Contract conformance", task),
    `This result must conform to the contract "${contract.name}". Check every request, response, type, field and name the result defines or uses against the contract. Differences in naming, types, required fields or status codes are failures.`,
    block(`Contract ${contract.name}`, contract.spec, 15_000),
    block("The result", result),
    'Answer with one JSON object in a ```json fence: {"verdict":"pass"|"fail","reasons":["…"]}.',
  ].join("\n\n");
}
