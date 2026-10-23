// Written before the implementation (M0 prompt): a planted secret must never survive redaction.
import { describe, expect, it } from "vitest";
import { REDACTED, Redactor } from "../src/redactor";

const planted = "brio-planted-9f8e7d6c5b4a39281706f5e4d3c2b1a0";

describe("Redactor", () => {
  it("removes a registered secret from text", () => {
    const r = new Redactor();
    r.register(planted);
    const out = r.redact(`calling api with key=${planted} now`);
    expect(out).not.toContain(planted);
    expect(out).toContain(REDACTED);
  });

  it("removes encoded forms of a registered secret", () => {
    const r = new Redactor();
    r.register(planted);
    const forms = [
      Buffer.from(planted).toString("base64"),
      Buffer.from(planted).toString("base64url"),
      encodeURIComponent(`${planted}/x`),
      Buffer.from(`user:${planted}`).toString("base64"),
      JSON.stringify(planted),
    ];
    for (const f of forms) expect(r.redact(`x ${f} y`), f).not.toContain(planted);
    expect(r.redact(`x ${Buffer.from(planted).toString("base64")} y`)).not.toContain(
      Buffer.from(planted).toString("base64"),
    );
  });

  it("ignores very short values instead of shredding normal text", () => {
    const r = new Redactor();
    r.register("abc");
    expect(r.redact("abc def")).toBe("abc def");
  });

  // Key-shaped fixtures are assembled at runtime so no literal resembling a real credential sits in the repo
  // (and secret scanners stay quiet). They match each provider's format, not any real key.
  const body = (n: number) => "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789".repeat(4).slice(0, n);
  it.each([
    ["OpenAI", ["sk", "proj", body(40)].join("-")],
    ["Anthropic", ["sk", "ant", "api03", body(48)].join("-")],
    ["Google", `${"AI"}za${body(35)}`],
    ["GitHub", `${"gh"}p_${body(36)}`],
    ["GitHub fine-grained", `${"github"}_pat_${body(22)}_${body(59)}`],
    ["Slack", [`xo${"xb"}`, "1234567890", "0987654321", body(24)].join("-")],
    ["AWS access key", `${"AK"}IA${"ABCDEFGHIJKLMNOP"}`],
    ["xAI", `${"xa"}i-${body(60)}`],
    ["JWT", [`ey${"J"}hbGciOiJIUzI1NiJ9`, `ey${"J"}zdWIiOiIxMjM0NTY3ODkwIn0`, body(43)].join(".")],
  ])("detects unregistered %s keys by pattern", (_, key) => {
    const out = new Redactor().redact(`token: ${key}`);
    expect(out).not.toContain(key);
  });

  it("redacts bearer tokens and PEM private keys", () => {
    const r = new Redactor();
    expect(r.redact("Authorization: Bearer abcdefghijklmnop1234567890")).not.toContain(
      "abcdefghijklmnop1234567890",
    );
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";
    expect(r.redact(`key:\n${pem}\n`)).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC");
  });

  it("redacts deeply in objects, arrays and by sensitive key names", () => {
    const r = new Redactor();
    r.register(planted);
    const out = r.redactDeep({
      a: [`x${planted}x`, { nested: planted }],
      headers: { authorization: "Basic dXNlcjpwYXNz", "x-api-key": "whatever-value-123" },
      password: "hunter2hunter2",
      apiKey: "short",
      count: 3,
      ok: true,
      none: null,
    });
    const s = JSON.stringify(out);
    expect(s).not.toContain(planted);
    expect(s).not.toContain("dXNlcjpwYXNz");
    expect(s).not.toContain("whatever-value-123");
    expect(s).not.toContain("hunter2hunter2");
    expect(s).not.toContain('"short"');
    expect(out).toMatchObject({ count: 3, ok: true, none: null });
  });

  it("does not mutate its input and survives cycles", () => {
    const r = new Redactor();
    r.register(planted);
    const input: Record<string, unknown> = { s: planted };
    input.self = input;
    const out = r.redactDeep(input) as Record<string, unknown>;
    expect(input.s).toBe(planted);
    expect(out.s).toBe(REDACTED);
    expect(out.self).toBe("[circular]");
  });

  it("redacts Error messages and stacks", () => {
    const r = new Redactor();
    r.register(planted);
    const out = r.redactDeep(new Error(`failed with ${planted}`)) as { message: string; stack: string };
    expect(JSON.stringify(out)).not.toContain(planted);
  });

  it("forget() stops redacting a value", () => {
    const r = new Redactor();
    r.register(planted);
    r.forget(planted);
    expect(r.redact(planted)).toBe(planted);
  });
});
