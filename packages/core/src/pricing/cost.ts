// Cost of a model call from its token usage and a price. Pure: prices come from the pricing table (data), usage from
// the vendor's response. Rounded to the micro-dollar, the precision of `attempts.cost_usd` (numeric(12,6)).

/** Token usage normalised across vendors. Buckets do not overlap: their sum is everything billed. */
export interface TokenUsage {
  /** Input tokens billed at the normal input rate (excludes cache reads and cache writes). */
  inputTokens: number;
  /** Input tokens served from the prompt cache. */
  cachedInputTokens: number;
  /** Input tokens written to the prompt cache (Anthropic bills these separately). */
  cacheWriteTokens: number;
  /** All output tokens, reasoning/thinking included (every vendor bills reasoning as output). */
  outputTokens: number;
  /** The part of outputTokens spent on reasoning; informational. */
  reasoningTokens: number;
}

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

/** USD per million tokens. */
export interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
  /** Null: the vendor has no cache discount, so cached tokens cost the input rate. */
  cachedInputPerM: number | null;
  /** Null: cache writes cost the input rate. */
  cacheWritePerM: number | null;
  /** Prices for prompts above a size threshold (e.g. long-context tiers), applied to the whole call. */
  longContext?: {
    thresholdTokens: number;
    inputPerM: number;
    outputPerM: number;
    cachedInputPerM: number | null;
  } | null;
  /**
   * Time-of-day pricing (DeepSeek): outside the peak windows every rate is multiplied by `multiplier`. Peak windows are
   * [startHour, endHour) in UTC. Vendor holidays are not modelled, so off-peak holidays are charged at peak (never under).
   */
  offPeak?: {
    multiplier: number;
    peakUtcHours: [number, number][];
    weekdaysOnly: boolean;
  } | null;
}

/** True when `at` falls in a peak window (or the price has no time-of-day rule). */
export function isPeak(price: ModelPrice, at: Date): boolean {
  const rule = price.offPeak;
  if (!rule) return true;
  const day = at.getUTCDay();
  if (rule.weekdaysOnly && (day === 0 || day === 6)) return false;
  const hour = at.getUTCHours() + at.getUTCMinutes() / 60;
  return rule.peakUtcHours.some(([start, end]) => hour >= start && hour < end);
}

export const FREE: ModelPrice = { inputPerM: 0, outputPerM: 0, cachedInputPerM: 0, cacheWritePerM: 0 };

export function promptTokens(u: TokenUsage): number {
  return u.inputTokens + u.cachedInputTokens + u.cacheWriteTokens;
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

export const roundUsd = (usd: number) => Math.round(usd * 1e6) / 1e6;

/**
 * The cost of one call made at `at` (the request time). Throws on negative or non-finite inputs rather than recording
 * a wrong number.
 */
export function costOf(usage: TokenUsage, price: ModelPrice, at: Date = new Date()): number {
  for (const [k, v] of Object.entries(usage))
    if (!Number.isFinite(v) || v < 0) throw new RangeError(`usage.${k} must be a non-negative number`);
  for (const k of ["inputPerM", "outputPerM"] as const)
    if (!Number.isFinite(price[k]) || price[k] < 0) throw new RangeError(`price.${k} must be non-negative`);

  const long =
    price.longContext && promptTokens(usage) > price.longContext.thresholdTokens ? price.longContext : null;
  const input = long?.inputPerM ?? price.inputPerM;
  const output = long?.outputPerM ?? price.outputPerM;
  const cached = (long ? long.cachedInputPerM : price.cachedInputPerM) ?? input;
  const cacheWrite = price.cacheWritePerM ?? input;

  const multiplier = isPeak(price, at) ? 1 : (price.offPeak?.multiplier ?? 1);
  const usd =
    ((usage.inputTokens * input +
      usage.cachedInputTokens * cached +
      usage.cacheWriteTokens * cacheWrite +
      usage.outputTokens * output) *
      multiplier) /
    1_000_000;
  return roundUsd(usd);
}

/** Relative difference between two costs (0.02 = 2%); 0 when both are zero. */
export function relativeError(actual: number, expected: number): number {
  if (expected === 0) return actual === 0 ? 0 : Number.POSITIVE_INFINITY;
  return Math.abs(actual - expected) / Math.abs(expected);
}

/**
 * A pre-dispatch estimate: prompt size from the rendered instructions (≈4 characters a token, rounded up) and the
 * output cap. Deliberately pessimistic: it assumes the whole output budget is used and nothing is cached.
 */
export function estimateCost(
  input: { promptChars: number; maxOutputTokens: number; turns?: number },
  price: ModelPrice,
): number {
  const turns = Math.max(1, input.turns ?? 1);
  const promptPerTurn = Math.ceil(input.promptChars / 4);
  const usage: TokenUsage = {
    ...ZERO_USAGE,
    // Each tool-loop turn resends the conversation; assume it grows by the output cap per turn.
    inputTokens: promptPerTurn * turns + input.maxOutputTokens * ((turns * (turns - 1)) / 2),
    outputTokens: input.maxOutputTokens * turns,
  };
  return costOf(usage, price);
}
