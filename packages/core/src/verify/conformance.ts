// contract_conformance by schema (ROUTING §4.1): when the contract carries a JSON Schema, the result's JSON files are
// validated against it; no model needed. Contracts without one are checked by a reviewer from another vendor.
import { Ajv, type ErrorObject } from "ajv";

/** A JSON Schema inside a contract's text: the whole spec, or a ```json block that looks like a schema. */
export function findJsonSchema(spec: string): Record<string, unknown> | null {
  const looksLikeSchema = (o: unknown): o is Record<string, unknown> =>
    !!o &&
    typeof o === "object" &&
    !Array.isArray(o) &&
    ("$schema" in o || ("type" in o && ("properties" in o || "items" in o)) || "oneOf" in o || "anyOf" in o);
  const candidates = [spec, ...[...spec.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1] ?? "")];
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c.trim());
      if (looksLikeSchema(parsed)) return parsed;
    } catch {
      // not JSON
    }
  }
  return null;
}

export interface ConformanceResult {
  passed: boolean;
  summary: string;
  errors: string[];
}

const describe = (e: ErrorObject) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`;

/** Validates each JSON document against the schema. `documents` maps a name (a file path) to its text. */
export function validateAgainstSchema(
  schema: Record<string, unknown>,
  documents: Record<string, string>,
): ConformanceResult {
  const names = Object.keys(documents);
  if (!names.length)
    return { passed: false, summary: "the result has no JSON to check against the schema", errors: [] };
  let validate: ReturnType<Ajv["compile"]>;
  try {
    const { $schema: _ignored, ...rest } = schema;
    validate = new Ajv({ allErrors: true, strict: false }).compile(rest);
  } catch (err) {
    return {
      passed: false,
      summary: `the contract's schema is invalid: ${(err as Error).message}`,
      errors: [],
    };
  }
  const errors: string[] = [];
  for (const name of names) {
    let data: unknown;
    try {
      data = JSON.parse(documents[name] as string);
    } catch {
      errors.push(`${name}: not valid JSON`);
      continue;
    }
    if (!validate(data)) for (const e of validate.errors ?? []) errors.push(`${name}: ${describe(e)}`);
  }
  return errors.length
    ? { passed: false, summary: `${errors.length} schema error(s): ${errors.slice(0, 5).join("; ")}`, errors }
    : { passed: true, summary: `${names.length} document(s) match the contract's schema`, errors };
}
