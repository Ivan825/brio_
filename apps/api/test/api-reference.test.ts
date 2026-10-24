// docs/API.md is generated from the routes (scripts/api-reference.ts): it must match the code, and every route says
// what it does. Run `pnpm --filter @brio/api docs:api` after changing routes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApiReference } from "../scripts/api-reference";

describe("API reference", () => {
  const generated = buildApiReference(join(__dirname, "../src"));

  it("matches the committed docs/API.md", () => {
    expect(readFileSync(join(__dirname, "../../../docs/API.md"), "utf8")).toBe(generated);
  });

  it("describes every route", () => {
    const undocumented = generated.split("\n").filter((l) => l.startsWith("| ") && l.endsWith("| – |"));
    expect(undocumented).toEqual([]);
  });
});
