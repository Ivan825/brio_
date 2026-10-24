import { type DbOrTx, schema } from "@brio/db";
import type { LedgerEntry, LedgerKind } from "@brio/schema";
import { redactor as defaultRedactor, type Redactor } from "@brio/vault";
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { buildEntry, type ChainVerdict, GENESIS_HASH, verifyChain } from "./ledger-chain";

const { ledger } = schema;

/** NOTIFY channel told a workspace's ledger has entries waiting to be chained. */
export const LEDGER_CHANNEL = "brio_ledger";

export interface AppendLedgerInput {
  workspaceId: string;
  kind: LedgerKind;
  payload: Record<string, unknown>;
}

/** An entry as written: in the ledger at once, numbered and hashed into its workspace's chain shortly after. */
export interface PendingLedgerEntry {
  id: string;
  workspaceId: string;
  kind: LedgerKind;
  payload: Record<string, unknown>;
  createdAt: Date;
}

/**
 * The append-only, hash-chained audit ledger, one chain per workspace (SECURITY_GOVERNANCE §8, D-98).
 *
 * An entry is written inside the transaction that does what it records, so it exists exactly when that happened; it is
 * numbered and hashed into the chain afterwards, in the order entries were written, by `chain` — run by the API's
 * worker within a fraction of a second, and by every reader before it reads. Business transactions therefore never
 * wait on the workspace's chain lock (one lock per workspace, held to commit, used to serialise every dispatch and
 * every spend). A database trigger lets a pending row be chained once and nothing else ever change.
 */
export class Ledger {
  constructor(private readonly redactor: Redactor = defaultRedactor) {}

  async append(db: DbOrTx, input: AppendLedgerInput): Promise<PendingLedgerEntry> {
    const payload = this.redactor.redactDeep(input.payload) as Record<string, unknown>;
    const [row] = await db
      .insert(ledger)
      .values({ workspaceId: input.workspaceId, kind: input.kind, payload })
      .returning();
    await db.execute(sql`select pg_notify(${LEDGER_CHANNEL}, ${input.workspaceId})`);
    const r = row as typeof ledger.$inferSelect;
    return { id: r.id, workspaceId: r.workspaceId, kind: r.kind, payload: r.payload, createdAt: r.createdAt };
  }

  /** Numbers and hashes a workspace's pending entries onto its chain, oldest first. Returns how many. */
  async chain(db: DbOrTx, workspaceId: string): Promise<number> {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`brio-ledger:${workspaceId}`}, 0))`,
      );
      const pending = await tx
        .select({ id: ledger.id, kind: ledger.kind, payload: ledger.payload })
        .from(ledger)
        .where(and(eq(ledger.workspaceId, workspaceId), isNull(ledger.hash)))
        .orderBy(asc(ledger.createdAt), asc(ledger.id));
      if (!pending.length) return 0;
      const [head] = await tx
        .select({ seq: ledger.seq, hash: ledger.hash })
        .from(ledger)
        .where(and(eq(ledger.workspaceId, workspaceId), isNotNull(ledger.hash), isNotNull(ledger.seq)))
        .orderBy(desc(ledger.seq))
        .limit(1);
      let seq = head?.seq ?? 0;
      let prev = head?.hash ?? GENESIS_HASH;
      for (const p of pending) {
        // The payload as stored (jsonb) is what verification reads back, so that is what is hashed.
        const e = buildEntry({ workspaceId, seq: ++seq, kind: p.kind, payload: p.payload }, prev);
        await tx
          .update(ledger)
          .set({ seq: e.seq, prevHash: e.prevHash, hash: e.hash })
          .where(eq(ledger.id, p.id));
        prev = e.hash;
      }
      return pending.length;
    });
  }

  /** Chains every workspace that has pending entries. Returns how many entries were chained. */
  async chainAll(db: DbOrTx): Promise<number> {
    const waiting = await db
      .selectDistinct({ workspaceId: ledger.workspaceId })
      .from(ledger)
      .where(isNull(ledger.hash));
    // One workspace that cannot be chained (its chain damaged) does not hold up the others; the failure is reported.
    let n = 0;
    const failed: Error[] = [];
    for (const w of waiting)
      n += await this.chain(db, w.workspaceId).catch((err: Error) => {
        failed.push(new Error(`workspace ${w.workspaceId}: ${err.message}`));
        return 0;
      });
    if (failed.length) throw new AggregateError(failed, failed.map((e) => e.message).join("; "));
    return n;
  }

  /** The workspace's chain, in order (pending entries are chained first). */
  async entries(db: DbOrTx, workspaceId: string): Promise<LedgerEntry[]> {
    await this.chain(db, workspaceId);
    return (await db
      .select()
      .from(ledger)
      .where(and(eq(ledger.workspaceId, workspaceId), isNotNull(ledger.hash)))
      .orderBy(asc(ledger.seq))) as LedgerEntry[];
  }

  async verify(db: DbOrTx, workspaceId: string): Promise<ChainVerdict> {
    return verifyChain(await this.entries(db, workspaceId));
  }
}

/** Keeps every workspace's chain current: chains pending entries as they are written (and on a timer, to be sure). */
export class LedgerChainer {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly db: DbOrTx,
    private readonly ledgerImpl: Ledger,
    private readonly onError: (err: Error) => void = () => {},
    private readonly everyMs = 250,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.poke(), this.everyMs);
    this.timer.unref();
    this.poke();
  }

  /** Chains now (coalesced: one pass at a time, and one more if poked meanwhile). */
  poke(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.ledgerImpl.chainAll(this.db).catch((err: Error) => this.onError(err));
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
