// Whether two footprints (paths and globs, relative to the repository root) can touch the same file. Conservative: when
// unsure, they overlap (a false overlap only serialises work; a missed one corrupts it).

const normal = (p: string) => p.trim().replace(/^\.\//, "").replace(/\/+$/, "").replace(/\/+/g, "/");

/** The literal directory prefix before the first wildcard, and whether the pattern has wildcards at all. */
function split(pattern: string): { prefix: string; wild: boolean } {
  const p = normal(pattern);
  const i = p.search(/[*?[{]/);
  if (i === -1) return { prefix: p, wild: false };
  const head = p.slice(0, i);
  return { prefix: head.includes("/") ? head.slice(0, head.lastIndexOf("/")) : "", wild: true };
}

const within = (path: string, dir: string) => dir === "" || path === dir || path.startsWith(`${dir}/`);

export function patternsOverlap(a: string, b: string): boolean {
  const x = split(a);
  const y = split(b);
  if (!x.wild && !y.wild)
    return x.prefix === y.prefix || within(x.prefix, y.prefix) || within(y.prefix, x.prefix);
  // A plain path is a file or a directory; a pattern covers its literal prefix's subtree.
  return within(x.prefix, y.prefix) || within(y.prefix, x.prefix);
}

export function footprintsOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((p) => b.some((q) => patternsOverlap(p, q)));
}
