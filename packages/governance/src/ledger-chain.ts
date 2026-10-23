// Pure hash-chain logic for the audit ledger (SECURITY_GOVERNANCE.md §8). No I/O.
import { createHash } from "node:crypto";
import type { LedgerKind } from "@brio/schema";

export const GENESIS_HASH = "0".repeat(64);

export interface ChainInput {
  workspaceId: string;
  seq: number;
  kind: LedgerKind;
  payload: Record<string, unknown>;
}

export interface ChainEntry extends ChainInput {
  prevHash: string;
  hash: string;
}

export type ChainVerdict =
  | { ok: true; length: number; head: string }
  | { ok: false; brokenAt: number; reason: "seq gap" | "prev_hash does not link" | "hash mismatch" };

/** Deterministic JSON: object keys sorted at every depth, no whitespace. Mirrors JSON.stringify for undefined. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value))
        return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
      if (value instanceof Date) return JSON.stringify(value.toISOString());
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
  }
}

/** hash = sha256(prev_hash || canonical_json({workspaceId, seq, kind, payload})). Binding seq, kind and workspace in
 * means an entry cannot be renumbered, relabelled or moved to another workspace's chain. */
export function entryHash(input: ChainInput, prevHash: string): string {
  const body = canonicalJson({
    workspaceId: input.workspaceId,
    seq: input.seq,
    kind: input.kind,
    payload: input.payload,
  });
  return createHash("sha256").update(prevHash).update(body).digest("hex");
}

export function buildEntry(input: ChainInput, prevHash: string): ChainEntry {
  return { ...input, prevHash, hash: entryHash(input, prevHash) };
}

/** Walks a workspace's chain in seq order. Reports the seq of the first entry that fails. */
export function verifyChain(entries: readonly ChainEntry[]): ChainVerdict {
  let prev = GENESIS_HASH;
  let expectedSeq = 1;
  for (const e of entries) {
    if (e.seq !== expectedSeq) return { ok: false, brokenAt: e.seq, reason: "seq gap" };
    if (e.prevHash !== prev) return { ok: false, brokenAt: e.seq, reason: "prev_hash does not link" };
    if (entryHash(e, e.prevHash) !== e.hash) return { ok: false, brokenAt: e.seq, reason: "hash mismatch" };
    prev = e.hash;
    expectedSeq++;
  }
  return { ok: true, length: entries.length, head: prev };
}
