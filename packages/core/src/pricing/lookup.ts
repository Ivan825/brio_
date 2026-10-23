// Which price applies to a model, decided from data already loaded. Pure, so the precedence is unit-tested.
import type { ModelPrice } from "./cost";

export type PriceSource = "vendor_docs" | "openrouter" | "models_endpoint";

export interface PriceRow {
  presetKey: string;
  model: string;
  price: ModelPrice;
  source: PriceSource;
  sourceUrl: string;
  fetchedAt: Date;
}

export type ResolvedPrice =
  | { kind: "override"; price: ModelPrice }
  | { kind: "table"; price: ModelPrice; row: PriceRow }
  | { kind: "free"; price: ModelPrice }
  | { kind: "unknown" };

/**
 * Live sources outrank the seeded docs table; a vendor's own endpoint outranks OpenRouter's mirror of it. A refresh
 * only replaces a row with an equal or better source.
 */
export const SOURCE_RANK: Record<PriceSource, number> = { vendor_docs: 1, openrouter: 2, models_endpoint: 3 };

/** A dated suffix (claude-x-20250929, gpt-x-2025-08-07) that vendors add to pinned snapshots of the same model. */
const DATED = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;

/**
 * OpenRouter ids a vendor model id may appear under, most specific first: "<prefix>/<id>", without a date suffix, and
 * with version dashes as dots (claude-opus-4-1 → claude-opus-4.1).
 */
export function openRouterCandidates(prefix: string, model: string): string[] {
  const base = model.replace(/^models\//, "").toLowerCase();
  const undated = base.replace(DATED, "");
  const dotted = undated.replace(/(\d)-(\d)(?=$|-)/g, "$1.$2");
  return [...new Set([base, undated, dotted])].map((m) => `${prefix}/${m}`);
}

/**
 * Precedence: the agent's own price, then the preset's own row, then OpenRouter's mirror of the vendor's model, then
 * free for local servers. Unknown means the run must not start (budgets need a price).
 */
export function resolvePrice(opts: {
  presetKey: string;
  model: string;
  override: ModelPrice | null;
  openrouterPrefix: string | null;
  free: boolean;
  rows: readonly PriceRow[];
}): ResolvedPrice {
  if (opts.override) return { kind: "override", price: opts.override };
  const exact = opts.rows.find((r) => r.presetKey === opts.presetKey && r.model === opts.model);
  if (exact) return { kind: "table", price: exact.price, row: exact };
  if (opts.openrouterPrefix) {
    for (const id of openRouterCandidates(opts.openrouterPrefix, opts.model)) {
      const row = opts.rows.find((r) => r.presetKey === "openrouter" && r.model === id);
      if (row) return { kind: "table", price: row.price, row };
    }
  }
  if (opts.free)
    return { kind: "free", price: { inputPerM: 0, outputPerM: 0, cachedInputPerM: 0, cacheWritePerM: 0 } };
  return { kind: "unknown" };
}

/** Whether an incoming price may replace the stored one. */
export function shouldReplace(existing: PriceSource | undefined, incoming: PriceSource): boolean {
  return existing === undefined || SOURCE_RANK[incoming] >= SOURCE_RANK[existing];
}
