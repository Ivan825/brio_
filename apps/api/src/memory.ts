// The memory ingest (M9): every event that teaches a project something goes into its graph, one at a time, as it is
// written. The graph is derived from the event log, so it can always be rebuilt from it.
import { readEventsSince } from "@brio/db";
import { ingestEvent, MEMORY_EVENTS } from "@brio/memory";
import type { AppContext } from "./context";

export class MemoryIngest {
  private unsubscribe: (() => void) | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    this.unsubscribe = this.ctx.feed.subscribeAll((missionId, seq, hint) => {
      if (!hint.type || !MEMORY_EVENTS.has(hint.type)) return;
      this.chain = this.chain.then(async () => {
        try {
          const [e] = await readEventsSince(this.ctx.db, missionId, seq - 1, 1);
          if (e && e.seq === seq) await ingestEvent(this.ctx.db, e);
        } catch (err) {
          this.ctx.log.warn({ err: (err as Error).message, missionId, seq }, "memory ingest failed");
        }
      });
    });
  }

  stop(): void {
    this.unsubscribe?.();
  }

  /** Waits for what is queued (tests). */
  async idle(): Promise<void> {
    await this.chain;
  }
}
