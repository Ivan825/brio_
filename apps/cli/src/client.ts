// The CLI's Brio API client: JSON over fetch with the CLI's session as a bearer token and the chosen workspace in
// x-brio-workspace; and a Server-Sent Events reader that resumes after the last event it saw.

export class BrioError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

export interface ClientOptions {
  url: string;
  session?: string;
  workspaceId?: string | null;
  fetch?: typeof fetch;
}

export interface SseEvent {
  id: number;
  type: string;
  data: unknown;
}

export class BrioClient {
  readonly url: string;
  private readonly f: typeof fetch;
  constructor(private readonly o: ClientOptions) {
    this.url = o.url.replace(/\/+$/, "");
    this.f = o.fetch ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...(this.o.session ? { authorization: `Bearer ${this.o.session}` } : {}),
      ...(this.o.workspaceId ? { "x-brio-workspace": this.o.workspaceId } : {}),
      ...extra,
    };
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.f(`${this.url}${path}`, {
      method,
      headers: this.headers(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const d = (data ?? {}) as {
        message?: string;
        error?: string;
        error_description?: string;
        issues?: { message: string }[];
      };
      const msg =
        d.issues?.map((i) => i.message).join(", ") ||
        d.message ||
        d.error_description ||
        d.error ||
        `HTTP ${res.status}`;
      throw new BrioError(res.status, d.error, msg);
    }
    return data as T;
  }

  get<T>(path: string) {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body?: unknown) {
    return this.request<T>("POST", path, body ?? {});
  }

  /**
   * Streams a mission's events, reconnecting (the server ends connections now and then) from the last id seen, until
   * `signal` aborts or `until` says to stop.
   */
  async events(
    missionId: string,
    onEvent: (e: SseEvent) => boolean | undefined | Promise<boolean | undefined>,
    o: { signal?: AbortSignal; after?: number; retryMs?: number } = {},
  ): Promise<void> {
    let last = o.after ?? 0;
    while (!o.signal?.aborted) {
      try {
        const res = await this.f(`${this.url}/v1/missions/${missionId}/events?lastEventId=${last}`, {
          headers: this.headers({ accept: "text/event-stream" }),
          ...(o.signal ? { signal: o.signal } : {}),
        });
        if (!res.ok || !res.body) throw new BrioError(res.status, undefined, `events: HTTP ${res.status}`);
        for await (const e of parseSse(res.body)) {
          last = Math.max(last, e.id);
          if ((await onEvent(e)) === true) return;
        }
      } catch (err) {
        if (o.signal?.aborted) return;
        if (err instanceof BrioError && err.status >= 400 && err.status < 500) throw err;
      }
      await new Promise((r) => setTimeout(r, o.retryMs ?? 1000));
    }
  }
}

/** Parses an event stream into events (id, event name, JSON data); comments and retry lines are skipped. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buf = "";
  let id = 0;
  let type = "message";
  let data: string[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
      if (line === "") {
        if (data.length) {
          let parsed: unknown = data.join("\n");
          try {
            parsed = JSON.parse(parsed as string);
          } catch {}
          yield { id, type, data: parsed };
        }
        type = "message";
        data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const at = line.indexOf(":");
      const field = at < 0 ? line : line.slice(0, at);
      const value = at < 0 ? "" : line.slice(at + 1).replace(/^ /, "");
      if (field === "id") id = Number(value) || id;
      else if (field === "event") type = value;
      else if (field === "data") data.push(value);
    }
  }
}
