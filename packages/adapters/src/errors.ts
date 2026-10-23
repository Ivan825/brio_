import type { AdapterErrorCode } from "./types";

export class AdapterError extends Error {
  override name = "AdapterError";
  constructor(
    readonly code: AdapterErrorCode,
    message: string,
    readonly status?: number,
    /** Seconds the vendor asked us to wait (Retry-After). */
    readonly retryAfterS?: number,
  ) {
    super(message);
  }

  get retryable(): boolean {
    return this.code === "rate_limited" || this.code === "unavailable" || this.code === "network";
  }
}

export function errorCodeForStatus(status: number): AdapterErrorCode {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  return "bad_request";
}

/** Why a run's signal was aborted. The orchestrator aborts with a LimitExceeded reason on a time or budget breach. */
export class LimitExceeded extends Error {
  override name = "LimitExceeded";
}

export function isLimitAbort(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason instanceof LimitExceeded;
}
