// HTTP for service connectors (hosted agents, media, search, browsers): the registry service gives the base URL, the
// auth scheme and the free key check; this sends requests with the right credentials, maps vendor errors, retries
// rate limits and 5xx, and downloads results through the same guarded fetch. Credentials never reach logs or errors.
import { AdapterError, errorCodeForStatus } from "../errors";
import { requestJson } from "../http";
import type { ConnectorConfig, FetchLike, HealthStatus, SecretHandle } from "../types";
import { type AwsCredentials, signV4 } from "./sigv4";

export interface ServiceContext {
  credential: SecretHandle | null;
  fetch: FetchLike;
  signal?: AbortSignal;
}

type Method = "GET" | "POST" | "DELETE" | "PUT" | "PATCH";

/** The service's base URL with its {setting} placeholders filled from the connector's settings. */
export function serviceBase(cfg: ConnectorConfig): string {
  const sv = cfg.service;
  if (!sv) throw new AdapterError("misconfigured", `${cfg.registryKey} is not a service connector`);
  const settings = cfg.settings ?? {};
  const url = (cfg.baseUrl || sv.baseUrl).replace(/\{(\w+)\}/g, (_m, k: string) => {
    const v = settings[k];
    if (!v) throw new AdapterError("misconfigured", `${sv.name} needs the setting ${k}`);
    return encodeURIComponent(v).replace(/%2F/gi, "/").replace(/%3A/gi, ":");
  });
  return url.replace(/\/+$/, "");
}

const entraTokens = new Map<string, { token: string; until: number }>();

/** A Microsoft Entra token for a service principal (client credentials), cached until shortly before it expires. */
async function entraToken(
  raw: string,
  scope: string,
  fetch: FetchLike,
  signal?: AbortSignal,
): Promise<string> {
  let p: { tenantId?: string; clientId?: string; clientSecret?: string };
  try {
    p = JSON.parse(raw);
  } catch {
    return raw; // already a bearer token
  }
  if (!p.tenantId || !p.clientId || !p.clientSecret)
    throw new AdapterError("misconfigured", "the Entra credential needs tenantId, clientId and clientSecret");
  const key = `${p.tenantId}|${p.clientId}|${scope}`;
  const hit = entraTokens.get(key);
  if (hit && hit.until > Date.now()) return hit.token;
  const res = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(p.tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: p.clientId,
        client_secret: p.clientSecret,
        scope,
      }).toString(),
      ...(signal ? { signal } : {}),
    },
  );
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!res.ok || !body.access_token)
    throw new AdapterError(
      res.status === 400 || res.status === 401 ? "auth" : errorCodeForStatus(res.status),
      `Entra sign-in failed: ${body.error ?? res.status}`,
    );
  entraTokens.set(key, {
    token: body.access_token,
    until: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 120) * 1000,
  });
  return body.access_token;
}

function awsCredentials(raw: string): AwsCredentials {
  try {
    const c = JSON.parse(raw) as AwsCredentials;
    if (c.accessKeyId && c.secretAccessKey) return c;
  } catch {
    // fall through
  }
  throw new AdapterError(
    "misconfigured",
    "the AWS credential must be JSON {accessKeyId, secretAccessKey, sessionToken?}",
  );
}

export class ServiceClient {
  readonly base: string;
  constructor(
    readonly cfg: ConnectorConfig,
    private readonly ctx: ServiceContext,
  ) {
    this.base = serviceBase(cfg);
  }

  private get service() {
    const sv = this.cfg.service;
    if (!sv) throw new AdapterError("misconfigured", "not a service connector");
    return sv;
  }

  /** Headers carrying the credential (and the service's fixed headers) for one request. */
  async headers(method: Method, url: string, body: string): Promise<Record<string, string>> {
    const sv = this.service;
    const raw = this.ctx.credential?.reveal() ?? "";
    const out: Record<string, string> = { ...sv.extraHeaders };
    if (!raw) return out;
    switch (sv.auth.scheme) {
      case "bearer":
      case "optional-bearer":
        return { ...out, authorization: `Bearer ${raw}` };
      case "header":
        return { ...out, [sv.auth.header]: raw };
      case "entra":
        return {
          ...out,
          authorization: `Bearer ${await entraToken(raw, sv.auth.scope, this.ctx.fetch, this.ctx.signal)}`,
        };
      case "aws-sigv4": {
        const region = this.cfg.settings?.region;
        if (!region) throw new AdapterError("misconfigured", `${sv.name} needs the setting region`);
        const signed = { ...out, "content-type": "application/json" };
        return {
          ...signed,
          ...signV4({ method, url, headers: signed, body }, awsCredentials(raw), region, sv.auth.service),
        };
      }
    }
  }

  /** A request through Brio's guarded fetch, for SDKs that build their own (the A2A client); callers add headers. */
  rawFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const signal = this.ctx.signal
      ? init.signal
        ? AbortSignal.any([this.ctx.signal, init.signal])
        : this.ctx.signal
      : init.signal;
    return this.ctx.fetch(url, { ...init, ...(signal ? { signal } : {}) });
  }

  url(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    const u = new URL(
      path.startsWith("http") ? path : `${this.base}${path.startsWith("/") ? "" : "/"}${path}`,
    );
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  /** A JSON request against the service, with its credentials, retries and error mapping. */
  async json<T = Record<string, unknown>>(
    method: Method,
    path: string,
    body?: unknown,
    opts: {
      query?: Record<string, string | number | boolean | undefined>;
      headers?: Record<string, string>;
      retries?: number;
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    const url = this.url(path, opts.query);
    const payload = body === undefined ? "" : JSON.stringify(body);
    const headers = { ...(await this.headers(method, url, payload)), ...opts.headers };
    const res = await requestJson<T>({
      fetch: this.ctx.fetch,
      url,
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(this.ctx.signal ? { signal: this.ctx.signal } : {}),
      retries: opts.retries ?? 2,
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
    return res.data;
  }

  /** A request whose answer is not JSON (or not only): the body as text, with its content type. */
  async text(
    method: Method,
    path: string,
    body?: unknown,
    opts: { headers?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<{ status: number; contentType: string; text: string }> {
    const url = this.url(path);
    const payload = body === undefined ? "" : JSON.stringify(body);
    const headers = {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(await this.headers(method, url, payload)),
      ...opts.headers,
    };
    const signal = AbortSignal.any([
      ...(this.ctx.signal ? [this.ctx.signal] : []),
      AbortSignal.timeout(opts.timeoutMs ?? 30 * 60_000),
    ]);
    let res: Response;
    try {
      res = await this.ctx.fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: payload }),
        signal,
      });
    } catch (e) {
      if (this.ctx.signal?.aborted) throw new AdapterError("cancelled", "cancelled");
      throw new AdapterError("network", `cannot reach the vendor: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok)
      throw new AdapterError(
        errorCodeForStatus(res.status),
        `${res.status}: ${text.slice(0, 300)}`,
        res.status,
      );
    return { status: res.status, contentType: res.headers.get("content-type") ?? "", text };
  }

  /**
   * Downloads a result, or makes a request whose answer is a file (speech, an image). `auth` sends the service's
   * credentials (its own endpoints); presigned URLs from the vendor get none. At most `maxBytes`.
   */
  async bytes(
    pathOrUrl: string,
    opts: {
      auth?: boolean;
      maxBytes?: number;
      method?: Method;
      body?: unknown;
      query?: Record<string, string | number | boolean | undefined>;
      timeoutMs?: number;
    } = {},
  ): Promise<{ bytes: Uint8Array; contentType: string; headers: Headers }> {
    const url = this.url(pathOrUrl, opts.query);
    const method = opts.method ?? "GET";
    const payload = opts.body === undefined ? "" : JSON.stringify(opts.body);
    const headers = {
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      ...(opts.auth === false ? {} : await this.headers(method, url, payload)),
    };
    const signal = AbortSignal.any([
      ...(this.ctx.signal ? [this.ctx.signal] : []),
      AbortSignal.timeout(opts.timeoutMs ?? 10 * 60_000),
    ]);
    let res: Response;
    try {
      res = await this.ctx.fetch(url, {
        method,
        headers,
        ...(opts.body === undefined ? {} : { body: payload }),
        signal,
      });
    } catch (e) {
      if (this.ctx.signal?.aborted) throw new AdapterError("cancelled", "cancelled");
      throw new AdapterError("network", `cannot reach the vendor: ${(e as Error).message}`);
    }
    if (!res.ok) {
      const detail = method === "GET" ? "" : `: ${(await res.text().catch(() => "")).slice(0, 300)}`;
      throw new AdapterError(
        errorCodeForStatus(res.status),
        `${method === "GET" ? "download failed" : "request failed"}: ${res.status}${detail}`,
        res.status,
      );
    }
    const max = opts.maxBytes ?? 50 * 1024 * 1024;
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > max)
      throw new AdapterError(
        "bad_request",
        `the result is ${Math.round(length / 1e6)} MB, over ${max / 1e6} MB`,
      );
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > max) throw new AdapterError("bad_request", `the result is over ${max / 1e6} MB`);
    return {
      bytes: buf,
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
      headers: res.headers,
    };
  }

  /** The service's free key check (registry `health`): a bad key is an auth failure, anything else answered is fine. */
  async check(): Promise<HealthStatus> {
    const started = performance.now();
    const h = this.service.health;
    const latency = () => Math.round(performance.now() - started);
    if (!h) return { ok: true, latencyMs: 0, detail: "no free key check; the first run checks the key" };
    try {
      await this.json(h.method, h.path, h.method === "POST" ? {} : undefined, {
        retries: 1,
        timeoutMs: 20_000,
      });
      return { ok: true, latencyMs: latency() };
    } catch (e) {
      const err = e instanceof AdapterError ? e : new AdapterError("network", (e as Error).message);
      if (err.status && h.badKey.includes(err.status))
        return { ok: false, latencyMs: latency(), error: "the key was rejected", code: "auth" };
      return { ok: false, latencyMs: latency(), error: err.message, code: err.code };
    }
  }
}
