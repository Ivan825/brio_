// The pricing table and its updater (BUILD_PLAN M1). Seed prices come from registry/prices.json (vendor docs, with the
// date they were checked); live prices from OpenRouter's public model list and from vendors whose own model list
// carries prices. Cost events record the price they used, so the table only needs the current price.
import { type FetchLike, listModelsFrom, type ModelInfo } from "@brio/adapters";
import {
  type ModelPrice,
  openRouterCandidates,
  type PriceRow,
  type PriceSource,
  type ResolvedPrice,
  resolvePrice,
  shouldReplace,
} from "@brio/core";
import { type DbOrTx, schema } from "@brio/db";
import { registry } from "@brio/registry";
import { and, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import seed from "../../../registry/prices.json" with { type: "json" };

const { modelPrices } = schema;

const SeedFile = z.object({
  version: z.literal("1"),
  note: z.string(),
  prices: z.array(
    z.object({
      preset: z.string(),
      model: z.string(),
      inputPerM: z.number().nonnegative(),
      outputPerM: z.number().nonnegative(),
      cachedInputPerM: z.number().nonnegative().nullable(),
      cacheWritePerM: z.number().nonnegative().nullable(),
      longContext: z
        .object({
          thresholdTokens: z.number().int().positive(),
          inputPerM: z.number().nonnegative(),
          outputPerM: z.number().nonnegative(),
          cachedInputPerM: z.number().nonnegative().nullable(),
        })
        .nullable()
        .optional(),
      offPeak: z
        .object({
          multiplier: z.number().positive().max(1),
          peakUtcHours: z.array(z.tuple([z.number(), z.number()])),
          weekdaysOnly: z.boolean(),
        })
        .optional(),
      currency: z.string().regex(/^[A-Z]{3}$/),
      sourceUrl: z.url(),
      verifiedOn: z.iso.date(),
    }),
  ),
});

export interface IncomingPrice {
  presetKey: string;
  model: string;
  price: ModelPrice;
  /** ISO 4217; defaults to USD. */
  currency?: string;
  source: PriceSource;
  sourceUrl: string;
  fetchedAt?: Date;
}

/** USD per unit of each currency, e.g. { INR: 0.0114 } (BRIO_FX_USD_PER="INR=0.0114"). */
export type FxRates = Readonly<Record<string, number>>;

export function parseFx(raw: string | undefined): FxRates {
  const out: Record<string, number> = {};
  for (const part of (raw ?? "").split(",")) {
    const [code, rate] = part.split("=").map((x) => x.trim());
    const n = Number(rate);
    if (code && /^[A-Z]{3}$/.test(code) && Number.isFinite(n) && n > 0) out[code] = n;
  }
  return out;
}

/** A stored price in USD, or null when it is in a currency the deployment has no rate for (then the price is unknown). */
function toRow(r: typeof modelPrices.$inferSelect, fx: FxRates): PriceRow | null {
  const rate = r.currency === "USD" ? 1 : fx[r.currency];
  if (!rate) return null;
  const conv = (n: number) => Math.round(n * rate * 1e6) / 1e6;
  const convN = (n: number | null) => (n === null ? null : conv(n));
  return {
    presetKey: r.presetKey,
    model: r.model,
    price: {
      inputPerM: conv(r.inputPerM),
      outputPerM: conv(r.outputPerM),
      cachedInputPerM: convN(r.cachedInputPerM),
      cacheWritePerM: convN(r.cacheWritePerM),
      longContext: r.longContext
        ? {
            ...r.longContext,
            inputPerM: conv(r.longContext.inputPerM),
            outputPerM: conv(r.longContext.outputPerM),
            cachedInputPerM: convN(r.longContext.cachedInputPerM),
          }
        : null,
      offPeak: r.offPeak ?? null,
    },
    source: r.source,
    sourceUrl: r.sourceUrl,
    fetchedAt: r.fetchedAt,
  };
}

export class PricingService {
  constructor(
    private readonly db: DbOrTx,
    private readonly fetch: FetchLike,
    private readonly fx: FxRates = {},
  ) {}

  /** Upserts prices, keeping a stored price when it came from a better source. Returns how many were written. */
  async upsert(prices: IncomingPrice[]): Promise<number> {
    if (prices.length === 0) return 0;
    const existing = await this.db
      .select({ presetKey: modelPrices.presetKey, model: modelPrices.model, source: modelPrices.source })
      .from(modelPrices)
      .where(inArray(modelPrices.presetKey, [...new Set(prices.map((p) => p.presetKey))]));
    const sourceOf = new Map(existing.map((e) => [`${e.presetKey}\u0000${e.model}`, e.source]));
    let written = 0;
    for (const p of prices) {
      if (!shouldReplace(sourceOf.get(`${p.presetKey}\u0000${p.model}`), p.source)) continue;
      const values = {
        presetKey: p.presetKey,
        model: p.model,
        inputPerM: p.price.inputPerM,
        outputPerM: p.price.outputPerM,
        cachedInputPerM: p.price.cachedInputPerM,
        cacheWritePerM: p.price.cacheWritePerM,
        longContext: p.price.longContext ?? null,
        offPeak: p.price.offPeak ?? null,
        currency: p.currency ?? "USD",
        source: p.source,
        sourceUrl: p.sourceUrl,
        fetchedAt: p.fetchedAt ?? new Date(),
      };
      await this.db
        .insert(modelPrices)
        .values(values)
        .onConflictDoUpdate({ target: [modelPrices.presetKey, modelPrices.model], set: values });
      written++;
    }
    return written;
  }

  /** Loads registry/prices.json. Cheap and offline; runs at startup. */
  async seed(): Promise<number> {
    const file = SeedFile.parse(seed);
    return this.upsert(
      file.prices.map((p) => ({
        presetKey: p.preset,
        model: p.model,
        price: {
          inputPerM: p.inputPerM,
          outputPerM: p.outputPerM,
          cachedInputPerM: p.cachedInputPerM,
          cacheWritePerM: p.cacheWritePerM,
          longContext: p.longContext ?? null,
          offPeak: p.offPeak ?? null,
        },
        currency: p.currency,
        source: "vendor_docs",
        sourceUrl: p.sourceUrl,
        fetchedAt: new Date(`${p.verifiedOn}T00:00:00Z`),
      })),
    );
  }

  /** Pulls OpenRouter's public model list (no key needed) and stores every priced model under preset "openrouter". */
  async refreshFromOpenRouter(signal?: AbortSignal): Promise<number> {
    const preset = registry().preset("openrouter");
    if (!preset?.baseUrl || !preset.models.path) throw new Error("the registry has no openrouter preset");
    const { models } = await listModelsFrom({
      fetch: this.fetch,
      baseUrl: preset.baseUrl,
      path: preset.models.path,
      shape: preset.models.shape,
      headers: {},
      ...(signal ? { signal } : {}),
    });
    return this.upsert(
      pricesFromModels("openrouter", models, "openrouter", `${preset.baseUrl}${preset.models.path}`),
    );
  }

  async lookup(opts: {
    presetKey: string;
    model: string;
    override: ModelPrice | null;
  }): Promise<ResolvedPrice> {
    const [resolved] = await this.lookupMany(opts.presetKey, [opts.model], opts.override);
    return resolved ?? { kind: "unknown" };
  }

  /** Resolves prices for many models of one preset with a single query. */
  async lookupMany(
    presetKey: string,
    models: string[],
    override: ModelPrice | null = null,
  ): Promise<ResolvedPrice[]> {
    const preset = registry().preset(presetKey);
    if (!preset) return models.map(() => ({ kind: "unknown" }));
    const prefix = preset.pricing.openrouterPrefix;
    const candidates = prefix ? models.flatMap((m) => openRouterCandidates(prefix, m)) : [];
    const rows =
      models.length === 0
        ? []
        : await this.db
            .select()
            .from(modelPrices)
            .where(
              or(
                and(eq(modelPrices.presetKey, presetKey), inArray(modelPrices.model, models)),
                candidates.length
                  ? and(eq(modelPrices.presetKey, "openrouter"), inArray(modelPrices.model, candidates))
                  : undefined,
              ),
            );
    const priceRows = rows.flatMap((r) => toRow(r, this.fx) ?? []);
    return models.map((model) =>
      resolvePrice({
        presetKey,
        model,
        override,
        openrouterPrefix: prefix,
        free: preset.pricing.free,
        rows: priceRows,
      }),
    );
  }

  async list(presetKey?: string): Promise<PriceRow[]> {
    const rows = await this.db
      .select()
      .from(modelPrices)
      .where(presetKey ? eq(modelPrices.presetKey, presetKey) : undefined)
      .orderBy(modelPrices.presetKey, modelPrices.model)
      .limit(5000);
    return rows.flatMap((r) => toRow(r, this.fx) ?? []);
  }
}

/** Prices reported by a model list (OpenRouter and gateways that publish them), ready to upsert. */
export function pricesFromModels(
  presetKey: string,
  models: ModelInfo[],
  source: PriceSource,
  sourceUrl: string,
): IncomingPrice[] {
  return models.flatMap((m) =>
    m.price ? [{ presetKey, model: m.id, price: m.price, source, sourceUrl }] : [],
  );
}
