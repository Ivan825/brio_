import { type DbOrTx, schema } from "@brio/db";
import type { LedgerEntry, LedgerKind } from "@brio/schema";
import { redactor as defaultRedactor, type Redactor } from "@brio/vault";
import { asc, desc, eq, sql } from "drizzle-orm";
import { buildEntry, type ChainVerdict, GENESIS_HASH, verifyChain } from "./ledger-chain";

const { ledger } = schema;

export interface AppendLedgerInput {
  workspaceId: string;
  kind: LedgerKind;
  payload: Record<string, unknown>;
}

/**
 * The append-only, hash-chained audit ledger, one chain per workspace. Appends for a workspace are serialised with a
 * transaction-scoped advisory lock, so seq is gapless and every entry links to the previous head.
 */
export class Ledger {
  constructor(private readonly redactor: Redactor = defaultRedactor) {}

  async append(db: DbOrTx, input: AppendLedgerInput): Promise<LedgerEntry> {
    const payload = this.redactor.redactDeep(input.payload) as Record<string, unknown>;
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`brio-ledger:${input.workspaceId}`}, 0))`,
      );
      const [head] = await tx
        .select({ seq: ledger.seq, hash: ledger.hash })
        .from(ledger)
        .where(eq(ledger.workspaceId, input.workspaceId))
        .orderBy(desc(ledger.seq))
        .limit(1);
      const entry = buildEntry(
        { workspaceId: input.workspaceId, seq: (head?.seq ?? 0) + 1, kind: input.kind, payload },
        head?.hash ?? GENESIS_HASH,
      );
      const [row] = await tx.insert(ledger).values(entry).returning();
      return row as LedgerEntry;
    });
  }

  async entries(db: DbOrTx, workspaceId: string): Promise<LedgerEntry[]> {
    return (await db
      .select()
      .from(ledger)
      .where(eq(ledger.workspaceId, workspaceId))
      .orderBy(asc(ledger.seq))) as LedgerEntry[];
  }

  async verify(db: DbOrTx, workspaceId: string): Promise<ChainVerdict> {
    return verifyChain(await this.entries(db, workspaceId));
  }
}
