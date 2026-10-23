// A scripted vendor for fixture tests: model-list GETs return the list pages in order, generation POSTs return the
// queued responses in order. Every request is recorded so tests can assert on URLs, headers and bodies.
import type { FetchLike } from "../src/types";

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status?: number; body: unknown; headers?: Record<string, string> } | "hang";

export class FakeVendor {
  readonly requests: RecordedRequest[] = [];
  private readonly lists: Reply[];
  private readonly generations: Reply[];

  constructor(opts: { lists?: unknown[]; generations?: Reply[] } = {}) {
    this.lists = (opts.lists ?? []).map((body) => ({ body }));
    this.generations = [...(opts.generations ?? [])];
  }

  queue(...replies: Reply[]): this {
    this.generations.push(...replies);
    return this;
  }

  get generationRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.method === "POST");
  }

  readonly fetch: FetchLike = async (input, init = {}) => {
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    this.requests.push({ url: String(input), method, headers, body });
    const reply = method === "GET" ? this.lists.shift() : this.generations.shift();
    if (!reply)
      return new Response(JSON.stringify({ error: { message: "fixture exhausted" } }), { status: 500 });
    if (reply === "hang")
      return new Promise<Response>((_, reject) => {
        const signal = init.signal;
        if (!signal) return;
        signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
      });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  };
}
