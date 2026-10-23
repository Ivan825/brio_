// A scriptable fake for service APIs: routes by method and path, records every request (headers included) so tests
// can assert auth and that no credential leaks, and serves JSON or bytes.
import type { FetchLike } from "../src/types";

export interface Recorded {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (req: Recorded, n: number) => unknown | Response | Promise<unknown | Response>;

export class FakeService {
  readonly requests: Recorded[] = [];
  private readonly routes: Array<{ method: string; path: RegExp; handler: Handler; calls: number }> = [];

  on(method: string, path: RegExp, handler: Handler): this {
    this.routes.push({ method, path, handler, calls: 0 });
    return this;
  }

  calls(method: string, path: RegExp): Recorded[] {
    return this.requests.filter((r) => r.method === method && path.test(r.path));
  }

  readonly fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    let body: unknown;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const req: Recorded = { method, url: url.toString(), path: url.pathname + url.search, headers, body };
    this.requests.push(req);
    const route = this.routes.find((r) => r.method === method && r.path.test(url.pathname + url.search));
    if (!route)
      return new Response(JSON.stringify({ error: { message: `no route ${method} ${url.pathname}` } }), {
        status: 404,
      });
    const out = await route.handler(req, route.calls++);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out ?? {}), { headers: { "content-type": "application/json" } });
  };
}

export const bytesResponse = (text: string, type = "text/plain") =>
  new Response(new TextEncoder().encode(text), { headers: { "content-type": type } });
