import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { agentColorVar, LOGO_FILES, THEME_COLOR } from "../src/index";

const pkg = resolve(import.meta.dirname, "..");
const source = resolve(pkg, "../../brand");
const read = (p: string) => readFileSync(p);

describe("packages/brand mirrors brand/", () => {
  it.each(["tokens.css", "tailwind.preset.ts"])("%s is identical to the source", (file) => {
    expect(read(resolve(pkg, file)).equals(read(resolve(source, file)))).toBe(true);
  });

  it("ships every logo file, byte for byte", () => {
    const files = readdirSync(resolve(source, "logo")).sort();
    expect(files).toEqual([...LOGO_FILES].sort());
    for (const f of files) {
      expect(read(resolve(pkg, "logo", f)).equals(read(resolve(source, "logo", f))), f).toBe(true);
    }
  });
});

describe("tokens", () => {
  const tokens = readFileSync(resolve(pkg, "tokens.css"), "utf8");

  it("THEME_COLOR matches --bg for both themes", () => {
    expect(tokens).toMatch(new RegExp(`--bg: ${THEME_COLOR.dark};`));
    expect(tokens).toMatch(new RegExp(`\\[data-theme="light"\\] \\{\\s*--bg: ${THEME_COLOR.light};`));
  });

  it("dark is the default colour scheme", () => {
    const rootBlock = tokens.slice(tokens.indexOf(":root {"), tokens.indexOf("@media"));
    expect(rootBlock).toContain("color-scheme: dark;");
  });

  it("shadcn.css maps only onto Brio tokens", () => {
    const shadcn = readFileSync(resolve(pkg, "shadcn.css"), "utf8");
    const decls = [...shadcn.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)];
    expect(decls.length).toBeGreaterThan(10);
    for (const [, name, value] of decls) expect(value, name).toMatch(/^var\(--[\w-]+\)$/);
    expect(shadcn).toContain("--background: var(--bg);");
    expect(shadcn).toContain("--ring: var(--focus);");
    expect(shadcn).toContain("--border: var(--line);");
  });
});

describe("agentColorVar", () => {
  it("assigns agent colours in order and wraps", () => {
    expect(agentColorVar(0)).toBe("var(--agent-1)");
    expect(agentColorVar(5)).toBe("var(--agent-6)");
    expect(agentColorVar(6)).toBe("var(--agent-1)");
  });
  it("rejects bad indexes", () => {
    expect(() => agentColorVar(-1)).toThrow(RangeError);
    expect(() => agentColorVar(1.5)).toThrow(RangeError);
  });
});
