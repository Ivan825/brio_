import type { Event } from "@brio/schema";
import type pg from "pg";
import type { DbOrTx } from "./client";
import { EVENTS_CHANNEL, readEventsSince } from "./events";

type Listener = (seq: number) => void;

/** What a notification says about its event, so a listener can skip the ones it does not care about. */
export interface EventHint {
  type: string | null;
  attemptId: string | null;
}

/**
 * Fans Postgres NOTIFYs on `brio_events` out to in-process subscribers, one dedicated connection per process.
 * Notifications are only wake-ups; streams always read events from the table, which is the source of truth.
 */
export class EventFeed {
  private client: pg.PoolClient | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly everything = new Set<(missionId: string, seq: number, hint: EventHint) => void>();
  private stopped = false;

  constructor(private readonly pool: pg.Pool) {}

  async start(): Promise<void> {
    this.stopped = false;
    const client = await this.pool.connect();
    client.on("notification", (msg) => {
      if (msg.channel !== EVENTS_CHANNEL || !msg.payload) return;
      try {
        const { missionId, seq, type, attemptId } = JSON.parse(msg.payload) as {
          missionId: string;
          seq: number;
          type?: string;
          attemptId?: string | null;
        };
        for (const l of this.listeners.get(missionId) ?? []) l(seq);
        for (const l of this.everything)
          l(missionId, seq, { type: type ?? null, attemptId: attemptId ?? null });
      } catch {
        // ignore malformed payloads
      }
    });
    client.on("error", () => this.reconnect());
    await client.query(`LISTEN ${EVENTS_CHANNEL}`);
    this.client = client;
  }

  private reconnect(): void {
    this.client?.release(true);
    this.client = null;
    if (this.stopped) return;
    setTimeout(() => {
      this.start().catch(() => this.reconnect());
      // listeners re-read from the table on their poll interval, so nothing is lost while disconnected
      for (const set of this.listeners.values()) for (const l of set) l(Number.MAX_SAFE_INTEGER);
    }, 1000).unref();
  }

  /** Whether the LISTEN connection is up (live events flow); false while it reconnects. */
  get listening(): boolean {
    return this.client !== null && !this.stopped;
  }

  /** Every mission's new events (the orchestrator reacts to them). Returns the unsubscribe function. */
  subscribeAll(listener: (missionId: string, seq: number, hint: EventHint) => void): () => void {
    this.everything.add(listener);
    return () => this.everything.delete(listener);
  }

  subscribe(missionId: string, listener: Listener): () => void {
    let set = this.listeners.get(missionId);
    if (!set) {
      set = new Set();
      this.listeners.set(missionId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(missionId);
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const c = this.client;
    this.client = null;
    if (c) {
      await c.query(`UNLISTEN ${EVENTS_CHANNEL}`).catch(() => undefined);
      c.release();
    }
  }
}

export interface StreamOptions {
  /** Resume after this seq (the SSE Last-Event-ID). 0 = from the start. */
  afterSeq: number;
  signal: AbortSignal;
  /** Safety net if a notification is ever missed. */
  pollMs?: number;
  batchSize?: number;
}

/**
 * Streams a mission's events in seq order, starting after `afterSeq`, then live. Reads always come from the table, so
 * a reconnect resumes without gaps and without duplicates. Resolves when the signal aborts.
 */
export async function streamMissionEvents(
  db: DbOrTx,
  feed: EventFeed,
  missionId: string,
  send: (event: Event) => void | Promise<void>,
  { afterSeq, signal, pollMs = 5000, batchSize = 500 }: StreamOptions,
): Promise<void> {
  let last = afterSeq;
  let running: Promise<void> | null = null;
  let again = false;

  const drain = async () => {
    do {
      again = false;
      for (;;) {
        if (signal.aborted) return;
        const batch = await readEventsSince(db, missionId, last, batchSize);
        for (const e of batch) {
          if (signal.aborted) return;
          await send(e);
          last = e.seq;
        }
        if (batch.length < batchSize) break;
      }
    } while (again && !signal.aborted);
  };

  const pump = () => {
    if (running) {
      again = true;
      return running;
    }
    running = drain().finally(() => {
      running = null;
    });
    return running;
  };

  const unsubscribe = feed.subscribe(missionId, (seq) => {
    if (seq > last) void pump();
  });
  const timer = setInterval(() => void pump(), pollMs);
  timer.unref();
  try {
    await pump();
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    await running;
  } finally {
    clearInterval(timer);
    unsubscribe();
  }
}
