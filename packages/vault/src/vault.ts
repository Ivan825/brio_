import { type DbOrTx, schema } from "@brio/db";
import { and, eq } from "drizzle-orm";
import { open, rewrap, seal, secretContext } from "./envelope";
import { type KeyProvider, VaultError } from "./keys";
import { redactor as defaultRedactor, type Redactor } from "./redactor";
import { SecretValue } from "./secret-value";

const { vaultSecrets } = schema;

export interface PutSecretInput {
  workspaceId: string;
  label: string;
  value: string;
  createdBy?: string | null;
}

export interface SecretMetadata {
  id: string;
  workspaceId: string;
  label: string;
  kekProvider: string;
  kekId: string;
  lastUsedAt: Date | null;
  createdAt: Date;
}

/** BYOK secret storage. Plaintext exists only in memory, only between reveal() and use. */
export class Vault {
  constructor(
    private readonly provider: KeyProvider,
    private readonly redactor: Redactor = defaultRedactor,
  ) {}

  async put(db: DbOrTx, input: PutSecretInput): Promise<SecretMetadata> {
    const label = input.label.trim();
    if (!label) throw new VaultError("a secret needs a label");
    if (!input.value) throw new VaultError("a secret needs a value");
    const sealed = await seal(input.value, this.provider, secretContext(input.workspaceId, label));
    const [row] = await db
      .insert(vaultSecrets)
      .values({ workspaceId: input.workspaceId, label, ...sealed, createdBy: input.createdBy ?? null })
      .returning();
    this.redactor.register(input.value);
    return toMetadata(row as typeof vaultSecrets.$inferSelect);
  }

  async reveal(db: DbOrTx, workspaceId: string, id: string): Promise<SecretValue> {
    const row = await this.find(db, workspaceId, id);
    const value = await open(row, this.provider, secretContext(row.workspaceId, row.label));
    this.redactor.register(value);
    await db.update(vaultSecrets).set({ lastUsedAt: new Date() }).where(eq(vaultSecrets.id, id));
    return new SecretValue(value);
  }

  async list(db: DbOrTx, workspaceId: string): Promise<SecretMetadata[]> {
    const rows = await db.select().from(vaultSecrets).where(eq(vaultSecrets.workspaceId, workspaceId));
    return rows.map(toMetadata);
  }

  /** Re-wrap a secret's data key under the current KEK (after a KEK rotation). */
  async rotate(db: DbOrTx, workspaceId: string, id: string): Promise<SecretMetadata> {
    const row = await this.find(db, workspaceId, id);
    const next = await rewrap(row, this.provider, secretContext(row.workspaceId, row.label));
    const [updated] = await db
      .update(vaultSecrets)
      .set({ dekWrapped: next.dekWrapped, kekId: next.kekId, kekProvider: next.kekProvider })
      .where(eq(vaultSecrets.id, id))
      .returning();
    return toMetadata(updated as typeof vaultSecrets.$inferSelect);
  }

  async remove(db: DbOrTx, workspaceId: string, id: string): Promise<void> {
    const res = await db
      .delete(vaultSecrets)
      .where(and(eq(vaultSecrets.id, id), eq(vaultSecrets.workspaceId, workspaceId)))
      .returning({ id: vaultSecrets.id });
    if (res.length === 0) throw new VaultError("secret not found");
  }

  private async find(db: DbOrTx, workspaceId: string, id: string) {
    const [row] = await db
      .select()
      .from(vaultSecrets)
      .where(and(eq(vaultSecrets.id, id), eq(vaultSecrets.workspaceId, workspaceId)));
    if (!row) throw new VaultError("secret not found");
    return row;
  }
}

function toMetadata(row: typeof vaultSecrets.$inferSelect): SecretMetadata {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    label: row.label,
    kekProvider: row.kekProvider,
    kekId: row.kekId,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}
