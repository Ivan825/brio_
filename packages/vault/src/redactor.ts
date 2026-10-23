// Secrets never in logs, prompts to third-party models, or events (CLAUDE.md rule 7).
// Two layers: exact values the vault has handed out (and their common encodings), and patterns for well-known key formats.

export const REDACTED = "[redacted]";

/** Values shorter than this are not registered: redacting them would shred ordinary text. */
export const MIN_SECRET_LENGTH = 8;

const KEY_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g, // OpenAI, Anthropic (sk-ant-), DeepSeek, Moonshot and other sk- keys
  /\bxai-[A-Za-z0-9]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g, // Google API keys
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{60,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key ids
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWTs
];

/** Credentials after an auth scheme or an obvious key=value; the label is kept, the value goes. */
const LABELLED_PATTERNS: readonly RegExp[] = [
  /\b(Bearer|Basic|Token)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(api[_-]?key|secret|password|passwd|access[_-]?token|refresh[_-]?token|client[_-]?secret)(\s*[=:]\s*["']?)[^\s"',;&]{8,}/gi,
];

const SENSITIVE_KEY =
  /^(?:password|passwd|secret|token|api[-_]?key|apikey|authorization|proxy-authorization|x-api-key|x-goog-api-key|cookie|set-cookie|private[-_]?key|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|credentials?|dek|kek)$/i;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every substring that appears whenever `secret` is base64-encoded inside a larger value, whatever its byte offset
 * (e.g. Basic auth `user:secret`). For each of the three alignments, keep only the characters that do not depend on
 * neighbouring bytes.
 */
function base64Fragments(secret: string, alphabet: "base64" | "base64url"): string[] {
  const bytes = Buffer.from(secret);
  const out: string[] = [];
  for (let offset = 0; offset < 3; offset++) {
    const padded = Buffer.concat([Buffer.alloc(offset), bytes]);
    const encoded = padded.toString(alphabet).replace(/=+$/, "");
    const start = offset === 0 ? 0 : Math.ceil((offset * 4) / 3);
    const usableBytes = padded.length - (padded.length % 3);
    const end = Math.floor((usableBytes * 4) / 3);
    const fragment = encoded.slice(start, end);
    if (fragment.length >= MIN_SECRET_LENGTH) out.push(fragment);
  }
  return out;
}

function variantsOf(secret: string): string[] {
  const variants = new Set<string>([secret]);
  variants.add(Buffer.from(secret).toString("base64"));
  variants.add(Buffer.from(secret).toString("base64url"));
  for (const f of base64Fragments(secret, "base64")) variants.add(f);
  for (const f of base64Fragments(secret, "base64url")) variants.add(f);
  variants.add(encodeURIComponent(secret));
  variants.add(JSON.stringify(secret).slice(1, -1));
  return [...variants].filter((v) => v.length >= MIN_SECRET_LENGTH);
}

export class Redactor {
  private readonly secrets = new Map<string, string[]>();
  private matcher: RegExp | null = null;

  /** Redact this exact value (and its common encodings) everywhere from now on. */
  register(secret: string): void {
    if (secret.length < MIN_SECRET_LENGTH || this.secrets.has(secret)) return;
    this.secrets.set(secret, variantsOf(secret));
    this.rebuild();
  }

  forget(secret: string): void {
    if (this.secrets.delete(secret)) this.rebuild();
  }

  get size(): number {
    return this.secrets.size;
  }

  private rebuild(): void {
    const all = [...new Set([...this.secrets.values()].flat())].sort((a, b) => b.length - a.length);
    this.matcher = all.length ? new RegExp(all.map(escapeRegExp).join("|"), "g") : null;
  }

  redact(text: string): string {
    let out = this.matcher ? text.replace(this.matcher, REDACTED) : text;
    for (const re of KEY_PATTERNS) out = out.replace(re, REDACTED);
    for (const re of LABELLED_PATTERNS)
      out = out.replace(re, (_m, label: string, sep: string) => `${label}${sep}${REDACTED}`);
    return out;
  }

  /** A redacted deep copy: strings are scrubbed, values under sensitive keys are dropped, cycles are cut. */
  redactDeep<T>(value: T): unknown {
    return this.walk(value, new WeakSet());
  }

  private walk(value: unknown, ancestors: WeakSet<object>, key?: string): unknown {
    if (
      key !== undefined &&
      SENSITIVE_KEY.test(key) &&
      value !== null &&
      value !== undefined &&
      value !== ""
    ) {
      return REDACTED;
    }
    if (typeof value === "string") return this.redact(value);
    if (value === null || typeof value !== "object") return value;
    if (value instanceof Date) return value;
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return "[binary]";
    if (ancestors.has(value)) return "[circular]";
    ancestors.add(value);
    try {
      if (value instanceof Error) {
        return {
          name: value.name,
          message: this.redact(value.message),
          ...(value.stack ? { stack: this.redact(value.stack) } : {}),
        };
      }
      if (Array.isArray(value)) return value.map((v) => this.walk(v, ancestors));
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.walk(v, ancestors, k);
      return out;
    } finally {
      ancestors.delete(value);
    }
  }
}

/** Process-wide redactor. The vault registers every secret it decrypts; loggers and the events writer use it. */
export const redactor = new Redactor();
