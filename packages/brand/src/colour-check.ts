// Enforces CLAUDE.md rule 10: colours come only from packages/brand.
// Scans source files for colour literals and Tailwind default-palette classes.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

export interface ColourViolation {
  file: string;
  line: number;
  match: string;
  rule: "hex" | "colour-function" | "tailwind-palette" | "token-opacity";
}

const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".scss", ".html"]);

const SKIPPED_DIRS = new Set([
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  "coverage",
  "test-results",
  "playwright-report",
  ".git",
]);

// A hex colour: # + 3/4/6/8 hex digits, not preceded by a word char or & (HTML entities) and not followed by a word char.
const HEX = /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const COLOUR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(\s*[\d.]/g;
const PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const UTILITIES =
  "bg|text|border|border-[trblxy]|ring|ring-offset|fill|stroke|from|via|to|outline|decoration|divide|shadow|accent|caret|placeholder";
const TAILWIND_PALETTE = new RegExp(
  `(?<![\\w-])(?:[\\w-]+:)*(?:${UTILITIES})-(?:(?:${PALETTE})-\\d{2,3}|white|black)(?:\\/\\d+)?(?![\\w-])`,
  "g",
);

// An opacity modifier on a brand colour (bg-accent/70): the preset's colours are CSS variables without an alpha
// channel, so Tailwind silently generates nothing and the element has no colour at all. Font sizes take /<line-height>.
const TOKEN_OPACITY = new RegExp(
  `(?<![\\w-])(?:[\\w-]+:)*(?:${UTILITIES})-(?!(?:2xs|xs|sm|base|md|lg|[2-9]?xl)\\/)[a-z][\\w-]*\\/\\d+(?![\\w-])`,
  "g",
);

/** Find colour literals in one file's text. */
export function findColourLiterals(text: string, file = "<inline>"): ColourViolation[] {
  const out: ColourViolation[] = [];
  const lines = text.split("\n");
  lines.forEach((content, i) => {
    for (const [rule, re] of [
      ["hex", HEX],
      ["colour-function", COLOUR_FUNCTION],
      ["tailwind-palette", TAILWIND_PALETTE],
      ["token-opacity", TOKEN_OPACITY],
    ] as const) {
      re.lastIndex = 0;
      for (const m of content.matchAll(re)) out.push({ file, line: i + 1, match: m[0], rule });
    }
  });
  return out;
}

function walk(dir: string, files: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, files);
    else if (SCANNED_EXTENSIONS.has(extname(name))) files.push(full);
  }
}

/**
 * Scan apps/ and packages/ under `root` for colour literals, skipping packages/brand (the one allowed home)
 * and any test files (which plant violations on purpose).
 */
export function scanRepoForColourLiterals(root: string): ColourViolation[] {
  const files: string[] = [];
  for (const top of ["apps", "packages"]) {
    try {
      walk(join(root, top), files);
    } catch {
      // directory may not exist yet
    }
  }
  const brandDir = `${join("packages", "brand")}${sep}`;
  return files
    .map((f) => relative(root, f))
    .filter((f) => !f.startsWith(brandDir))
    .filter((f) => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(f))
    .flatMap((f) => findColourLiterals(readFileSync(join(root, f), "utf8"), f));
}
