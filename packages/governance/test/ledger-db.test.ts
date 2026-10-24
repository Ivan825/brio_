// Tamper tests against Postgres, written before the implementation. The trigger stops ordinary edits; these tests
// disable it as the table owner (what an attacker with DB access could do) and prove verification still catches it.
import { DEMO, schema, seedDemo } from "@brio/db";
import { createTestDb, hasTestDatabase, type TestDb } from "@brio/db/testing";
import { Redactor } from "@brio/vault";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger";

describe.skipIf(!hasTestDatabase)("Ledger (Postgres)", () => {
  let t: TestDb;
  const redactor = new Redactor();
  const ledger = new Ledger(redactor);

  beforeAll(async () => {
    t = await createTestDb();
    await seedDemo(t.db);
  });
  afterAll(async () => t?.drop());

  const tamper = async (statement: ReturnType<typeof sql>) => {
    await t.db.execute(sql`alter table ledger disable trigger ledger_append_only`);
    try {
      await t.db.execute(statement);
    } finally {
      await t.db.execute(sql`alter table ledger enable trigger ledger_append_only`);
    }
  };

  it("writes entries at once and chains them, in order, into a gapless chain that verifies", async () => {
    for (let i = 0; i < 5; i++)
      await ledger.append(t.db, { workspaceId: DEMO.workspaceId, kind: "spend", payload: { usd: i } });
    // Written, not yet chained (D-98).
    const pending = await t.db
      .select()
      .from(schema.ledger)
      .where(eq(schema.ledger.workspaceId, DEMO.workspaceId));
    expect(pending.map((r) => [r.seq, r.hash])).toEqual(Array.from({ length: 5 }, () => [null, null]));
    expect(await ledger.chain(t.db, DEMO.workspaceId)).toBe(5);
    const rows = await t.db
      .select()
      .from(schema.ledger)
      .where(eq(schema.ledger.workspaceId, DEMO.workspaceId))
      .orderBy(asc(schema.ledger.seq));
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.map((r) => (r.payload as { usd: number }).usd)).toEqual([0, 1, 2, 3, 4]);
    expect(await ledger.verify(t.db, DEMO.workspaceId)).toMatchObject({ ok: true, length: 5 });
  });

  it("stays gapless under concurrent appends and concurrent chainers", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        ledger.append(t.db, { workspaceId: DEMO.workspaceId, kind: "dispatch", payload: { i } }),
      ),
    );
    // Two chainers at once (two worker processes): one chains, the other finds nothing left; no fork.
    const chained = await Promise.all([ledger.chain(t.db, DEMO.workspaceId), ledger.chainAll(t.db)]);
    expect(chained[0] + chained[1]).toBe(20);
    const result = await ledger.verify(t.db, DEMO.workspaceId);
    expect(result).toMatchObject({ ok: true, length: 25 });
  });

  it("redacts secrets before they reach the ledger", async () => {
    const planted = "planted-secret-ledger-0123456789abcdef";
    redactor.register(planted);
    const entry = await ledger.append(t.db, {
      workspaceId: DEMO.workspaceId,
      kind: "key.added",
      payload: { label: "x", note: `value ${planted}` },
    });
    expect(JSON.stringify(entry)).not.toContain(planted);
    const dump = await t.db.execute(sql`select payload::text as p from ledger`);
    expect(JSON.stringify(dump.rows)).not.toContain(planted);
  });

  it("fails verification after a payload is edited behind the trigger", async () => {
    await tamper(
      sql`update ledger set payload = '{"usd": 1000}'::jsonb where workspace_id = ${DEMO.workspaceId} and seq = 3`,
    );
    expect(await ledger.verify(t.db, DEMO.workspaceId)).toMatchObject({ ok: false, brokenAt: 3 });
  });

  it("fails verification after an entry is deleted behind the trigger", async () => {
    const t2 = await createTestDb();
    try {
      await seedDemo(t2.db);
      for (let i = 0; i < 4; i++)
        await ledger.append(t2.db, { workspaceId: DEMO.workspaceId, kind: "spend", payload: { i } });
      await ledger.chain(t2.db, DEMO.workspaceId);
      await t2.db.execute(sql`alter table ledger disable trigger ledger_append_only`);
      await t2.db.execute(sql`delete from ledger where seq = 2`);
      await t2.db.execute(sql`alter table ledger enable trigger ledger_append_only`);
      expect(await ledger.verify(t2.db, DEMO.workspaceId)).toMatchObject({ ok: false, brokenAt: 3 });
    } finally {
      await t2.drop();
    }
  });

  it("the trigger itself blocks ordinary edits", async () => {
    await expect(t.db.execute(sql`update ledger set kind = 'spend' where seq = 1`)).rejects.toThrow();
    await expect(t.db.execute(sql`delete from ledger where seq = 1`)).rejects.toThrow();
  });

  /** Refused by the append-only trigger itself (drizzle wraps the database's error). */
  const refused = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => null,
      (e: Error & { cause?: Error }) => e,
    );
    expect(String(err?.cause?.message ?? err?.message)).toMatch(/append-only/);
  };

  it("lets a pending entry be chained once, and nothing else change", async () => {
    const e = await ledger.append(t.db, {
      workspaceId: DEMO.workspaceId,
      kind: "spend",
      payload: { usd: 7 },
    });
    // Its content cannot change while it waits.
    await refused(t.db.execute(sql`update ledger set payload = '{"usd": 7000}'::jsonb where id = ${e.id}`));
    // Chaining it changes only its place in the chain; then it is fixed like every other entry.
    expect(await ledger.chain(t.db, DEMO.workspaceId)).toBe(1);
    await refused(
      t.db.execute(
        sql`update ledger set hash = repeat('0', 64), prev_hash = repeat('0', 64) where id = ${e.id}`,
      ),
    );
    await refused(
      t.db.execute(sql`update ledger set seq = null, hash = null, prev_hash = null where id = ${e.id}`),
    );
  });
});
