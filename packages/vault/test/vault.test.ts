import { randomBytes } from "node:crypto";
import { DEMO, schema, seedDemo } from "@brio/db";
import { createTestDb, hasTestDatabase, type TestDb } from "@brio/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalKeyProvider, VaultError } from "../src/keys";
import { Redactor } from "../src/redactor";
import { Vault } from "../src/vault";

const planted = "sk-planted-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

describe.skipIf(!hasTestDatabase)("Vault (Postgres)", () => {
  let t: TestDb;
  const oldKey = randomBytes(32);
  const redactor = new Redactor();
  const vault = new Vault(new LocalKeyProvider([oldKey]), redactor);

  beforeAll(async () => {
    t = await createTestDb();
    await seedDemo(t.db);
  });
  afterAll(async () => t?.drop());

  it("round-trips a secret and stores only ciphertext", async () => {
    const meta = await vault.put(t.db, { workspaceId: DEMO.workspaceId, label: "openai", value: planted });
    expect(meta).toMatchObject({ label: "openai", kekProvider: "local" });
    expect(JSON.stringify(meta)).not.toContain(planted);

    const [row] = await t.db.select().from(schema.vaultSecrets).where(eq(schema.vaultSecrets.id, meta.id));
    expect(row!.ciphertext.includes(Buffer.from(planted))).toBe(false);
    expect(JSON.stringify(row)).not.toContain(planted);

    const value = await vault.reveal(t.db, DEMO.workspaceId, meta.id);
    expect(value.reveal()).toBe(planted);
    expect(String(value)).toBe("[redacted]");
    const [used] = await t.db.select().from(schema.vaultSecrets).where(eq(schema.vaultSecrets.id, meta.id));
    expect(used!.lastUsedAt).toBeInstanceOf(Date);
  });

  it("registers stored secrets with the redactor", async () => {
    expect(redactor.redact(`header: x-key ${planted}`)).not.toContain(planted);
  });

  it("will not open a secret from another workspace", async () => {
    const meta = await vault.put(t.db, {
      workspaceId: DEMO.workspaceId,
      label: "anthropic",
      value: "sk-ant-xyz-0123456789abcdef",
    });
    await expect(vault.reveal(t.db, "01900000-0000-7000-8000-00000000ffff", meta.id)).rejects.toThrow(
      "secret not found",
    );
  });

  it("detects a ciphertext swapped between rows", async () => {
    const a = await vault.put(t.db, {
      workspaceId: DEMO.workspaceId,
      label: "a",
      value: "value-a-0123456789",
    });
    const b = await vault.put(t.db, {
      workspaceId: DEMO.workspaceId,
      label: "b",
      value: "value-b-0123456789",
    });
    const [rowA] = await t.db.select().from(schema.vaultSecrets).where(eq(schema.vaultSecrets.id, a.id));
    await t.db
      .update(schema.vaultSecrets)
      .set({ ciphertext: rowA!.ciphertext, dekWrapped: rowA!.dekWrapped })
      .where(eq(schema.vaultSecrets.id, b.id));
    await expect(vault.reveal(t.db, DEMO.workspaceId, b.id)).rejects.toThrow(VaultError);
  });

  it("rotates secrets onto a new KEK", async () => {
    const meta = await vault.put(t.db, {
      workspaceId: DEMO.workspaceId,
      label: "rotate-me",
      value: "rotate-0123456789",
    });
    const newKey = randomBytes(32);
    const rotated = new Vault(new LocalKeyProvider([newKey, oldKey]), redactor);
    const after = await rotated.rotate(t.db, DEMO.workspaceId, meta.id);
    expect(after.kekId).toBe(LocalKeyProvider.idOf(newKey));
    const onlyNew = new Vault(new LocalKeyProvider([newKey]), redactor);
    expect((await onlyNew.reveal(t.db, DEMO.workspaceId, meta.id)).reveal()).toBe("rotate-0123456789");
  });

  it("rejects empty labels and values, and duplicate labels", async () => {
    await expect(vault.put(t.db, { workspaceId: DEMO.workspaceId, label: " ", value: "x" })).rejects.toThrow(
      VaultError,
    );
    await expect(vault.put(t.db, { workspaceId: DEMO.workspaceId, label: "x", value: "" })).rejects.toThrow(
      VaultError,
    );
    await expect(
      vault.put(t.db, { workspaceId: DEMO.workspaceId, label: "openai", value: "another-0123456789" }),
    ).rejects.toThrow();
  });

  it("removes secrets", async () => {
    const meta = await vault.put(t.db, {
      workspaceId: DEMO.workspaceId,
      label: "gone",
      value: "gone-0123456789",
    });
    await vault.remove(t.db, DEMO.workspaceId, meta.id);
    await expect(vault.reveal(t.db, DEMO.workspaceId, meta.id)).rejects.toThrow("secret not found");
  });
});
