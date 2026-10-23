// A small argv parser: positionals, `--flag`, `--key value`, `--key=value`, repeated keys collected.

export interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
  /** Every value a repeated option was given, in order. */
  all: Record<string, string[]>;
}

/** Options that never take a value. */
const BOOLEAN = new Set(["quick", "watch", "once", "deny", "json", "as-is", "help", "no-open", "approve"]);

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {}, all: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const key = a.slice(2, eq < 0 ? undefined : eq);
    let value: string | boolean;
    if (eq >= 0) value = a.slice(eq + 1);
    else if (BOOLEAN.has(key) || i + 1 >= argv.length || (argv[i + 1] as string).startsWith("--"))
      value = true;
    else value = argv[++i] as string;
    out.flags[key] = value;
    if (typeof value === "string") out.all[key] = [...(out.all[key] ?? []), value];
  }
  return out;
}

export const str = (a: Args, k: string): string | undefined => {
  const v = a.flags[k];
  return typeof v === "string" ? v : undefined;
};
