// Written before the implementation (M0 prompt): the chain verifies, and any tampering is detected.
import { describe, expect, it } from "vitest";
import { buildEntry, type ChainEntry, canonicalJson, GENESIS_HASH, verifyChain } from "../src/ledger-chain";

const ws = "01900000-0000-7000-8000-000000000002";

function chain(n: number): ChainEntry[] {
  const out: ChainEntry[] = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= n; i++) {
    const e = buildEntry(
      { workspaceId: ws, seq: i, kind: "spend", payload: { usd: i / 10, note: `call ${i}` } },
      prev,
    );
    out.push(e);
    prev = e.hash;
  }
  return out;
}

describe("canonicalJson", () => {
  it("sorts keys at every depth and drops whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: "s" } })).toBe(
      '{"a":{"c":"s","d":[3,{"x":2,"y":1}]},"b":1}',
    );
  });
  it("is stable across key order", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
  it("drops undefined like JSON and rejects non-finite numbers", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow();
  });
});

describe("verifyChain", () => {
  it("accepts an intact chain", () => {
    expect(verifyChain(chain(5))).toEqual({ ok: true, length: 5, head: chain(5)[4]?.hash });
  });

  it("accepts an empty chain", () => {
    expect(verifyChain([])).toEqual({ ok: true, length: 0, head: GENESIS_HASH });
  });

  it("detects an edited payload", () => {
    const c = chain(5);
    c[2] = { ...c[2]!, payload: { usd: 999, note: "call 3" } };
    expect(verifyChain(c)).toMatchObject({ ok: false, brokenAt: 3, reason: "hash mismatch" });
  });

  it("detects an edited kind", () => {
    const c = chain(3);
    c[0] = { ...c[0]!, kind: "dispatch" };
    expect(verifyChain(c)).toMatchObject({ ok: false, brokenAt: 1 });
  });

  it("detects a deleted entry", () => {
    const c = chain(5);
    c.splice(1, 1);
    expect(verifyChain(c)).toMatchObject({ ok: false, brokenAt: 3 });
  });

  it("detects reordered entries", () => {
    const c = chain(4);
    [c[1], c[2]] = [c[2]!, c[1]!];
    expect(verifyChain(c).ok).toBe(false);
  });

  it("detects a recomputed hash that no longer links to the next entry", () => {
    const c = chain(4);
    const forged = buildEntry({ workspaceId: ws, seq: 2, kind: "spend", payload: { usd: 0 } }, c[0]!.hash);
    c[1] = forged;
    expect(verifyChain(c)).toMatchObject({ ok: false, brokenAt: 3, reason: "prev_hash does not link" });
  });

  it("detects entries moved from another workspace", () => {
    const c = chain(2);
    c[1] = { ...c[1]!, workspaceId: "01900000-0000-7000-8000-00000000ffff" };
    expect(verifyChain(c).ok).toBe(false);
  });
});
