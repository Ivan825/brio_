import type { AuthScheme } from "@brio/registry";
import { AdapterError, errorCodeForStatus } from "./errors";
import type { FetchLike, SecretHandle } from "./types";

/** The request headers that carry the credential for a preset's auth scheme. */
export function authHeaders(scheme: AuthScheme, credential: SecretHandle | null): Record<string, string> {
  if (scheme === "none") return {};
  if (!credential) {
    if (scheme === "optional-bearer") return {};
    throw new AdapterError("misconfigured", "this connector needs an API key");
  }
  const key = credential.reveal();
  switch (scheme) {
    case "bearer":
    case "optional-bearer":
      return { authorization: `Bearer ${key}` };
    case "x-api-key":
      return { "x-api-key": key };
    case "x-goog-api-key":
      return { "x-goog-api-key": key };
  }
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** The vendor's own error message from a JSON error body, kept short. Never includes request headers. */
function vendorMessage(body: string): string {
  try {
    const j = JSON.parse(body) as {
      error?: { message?: string } | string;
      message?: string;
      detail?: string;
    };
    const m = typeof j.error === "string" ? j.error : (j.error?.message ?? j.message ?? j.detail);
    if (m) return m.slice(0, 500);
  } catch {
    // not JSON
  }
  return body.slice(0, 200) || "no details";
}

function retryAfterSeconds(h: string | null): number | undefined {
  if (!h) return undefined;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.max(0, n);
  const at = Date.parse(h);
  return Number.isNaN(at) ? undefined : Math.max(0, (at - Date.now()) / 1000);
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

export interface JsonRequest {
  fetch: FetchLike;
  url: string;
  method?: "GET" | "POST" | "DELETE" | "PUT" | "PATCH";
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  /** Retries for rate limits, 5xx and network errors (with backoff and Retry-After). Default 2. */
  retries?: number;
  /** Per-request timeout. Default 10 minutes (long generations). */
  timeoutMs?: number;
}

export interface JsonResponse<T> {
  data: T;
  status: number;
  headers: Headers;
  latencyMs: number;
}

/** One JSON request with retries, timeouts, cancellation and vendor error mapping. */
export async function requestJson<T = unknown>(req: JsonRequest): Promise<JsonResponse<T>> {
  const outer = req.signal ?? new AbortController().signal;
  const retries = req.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    const started = performance.now();
    const signal = AbortSignal.any([outer, AbortSignal.timeout(req.timeoutMs ?? 600_000)]);
    try {
      let res: Response;
      try {
        res = await req.fetch(req.url, {
          method: req.method ?? (req.body === undefined ? "GET" : "POST"),
          headers: {
            accept: "application/json",
            ...(req.body === undefined ? {} : { "content-type": "application/json" }),
            ...req.headers,
          },
          body: req.body === undefined ? undefined : JSON.stringify(req.body),
          signal,
        });
      } catch (e) {
        if (outer.aborted) throw new AdapterError("cancelled", "cancelled");
        if (e instanceof AdapterError) throw e;
        if (signal.aborted) throw new AdapterError("timeout", "the vendor did not answer in time");
        throw new AdapterError("network", `cannot reach the vendor: ${(e as Error).message}`);
      }
      const text = await res.text();
      const latencyMs = Math.round(performance.now() - started);
      if (!res.ok) {
        throw new AdapterError(
          errorCodeForStatus(res.status),
          `${res.status}: ${vendorMessage(text)}`,
          res.status,
          retryAfterSeconds(res.headers.get("retry-after")),
        );
      }
      try {
        return { data: JSON.parse(text) as T, status: res.status, headers: res.headers, latencyMs };
      } catch {
        throw new AdapterError("invalid_response", "the vendor returned something that is not JSON");
      }
    } catch (e) {
      if (!(e instanceof AdapterError) || !e.retryable || attempt >= retries || outer.aborted) throw e;
      const backoffMs = Math.min(20_000, (e.retryAfterS ?? 2 ** attempt) * 1000);
      await sleep(backoffMs, outer).catch(() => {
        throw new AdapterError("cancelled", "cancelled");
      });
    }
  }
}
