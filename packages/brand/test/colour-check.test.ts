import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findColourLiterals, scanRepoForColourLiterals } from "../src/colour-check";

const repoRoot = resolve(import.meta.dirname, "../../..");

describe("findColourLiterals", () => {
  it.each([
    ['const c = "#F2B33D";', "hex"],
    ["color: #fff;", "hex"],
    ['<div className="bg-[#121527]" />', "hex"],
    ["background: rgba(0, 0, 0, 0.4);", "colour-function"],
    ["fill: hsl(210 40% 50%);", "colour-function"],
    ["color: oklch(0.7 0.1 200);", "colour-function"],
    ['className="bg-zinc-900"', "tailwind-palette"],
    ['className="text-white"', "tailwind-palette"],
    ['className="hover:bg-red-500/50"', "tailwind-palette"],
    ['className="dark:border-slate-700"', "tailwind-palette"],
  ] as const)("flags %s", (text, rule) => {
    const found = findColourLiterals(text);
    expect(found.map((v) => v.rule)).toContain(rule);
  });

  it.each([
    'className="bg-surface-2 text-fg-muted border-line"',
    'className="bg-agent-1 text-running ring-focus"',
    "color: var(--text);",
    '<a href="#main">skip</a>',
    "&#123; entity",
    "const id = item.id; // #42",
    "background: currentColor;",
  ])("allows %s", (text) => {
    expect(findColourLiterals(text)).toEqual([]);
  });

  it("reports line numbers", () => {
    const [v] = findColourLiterals("ok\nok\ncolor: #abcdef;", "x.css");
    expect(v).toMatchObject({ file: "x.css", line: 3, match: "#abcdef" });
  });
});

describe("repository", () => {
  it("has no colour literals outside packages/brand", () => {
    expect(scanRepoForColourLiterals(repoRoot)).toEqual([]);
  });
});
