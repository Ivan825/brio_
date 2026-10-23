// The planner's answer → a validated PlanGraph, or the validation errors to send back for a retry (ROUTING §2 step 1).
import { PlanGraph } from "@brio/schema";

export type ParsedPlan = { ok: true; graph: PlanGraph } | { ok: false; errors: string[] };

/** The JSON object in a model's answer: a ```json fence if there is one, else the outermost braces. */
export function extractJson(text: string): string | null {
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(text);
  if (fence?.[1]) return fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

export function parsePlan(text: string): ParsedPlan {
  const raw = extractJson(text);
  if (!raw) return { ok: false, errors: ["the answer contains no JSON object"] };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    return { ok: false, errors: [`the JSON does not parse: ${(e as Error).message}`] };
  }
  const parsed = PlanGraph.safeParse(value);
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  return { ok: true, graph: parsed.data };
}
