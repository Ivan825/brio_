import { eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { events, ledger, members, messages, missions, workspaces } from "../src/schema/index";
import { DEMO, seedDemo } from "../src/seed";
import { createTestDb, hasTestDatabase, type TestDb } from "../src/testing";

if (!hasTestDatabase) console.warn("TEST_DATABASE_URL not set: skipping @brio/db integration tests");

const EXPECTED_TABLES = [
  "accounts",
  "agents",
  "approvals",
  "artifacts",
  "attempts",
  "budgets",
  "connectors",
  "contracts",
  "crews",
  "events",
  "handoffs",
  "invitations",
  "leases",
  "ledger",
  "members",
  "memory_edges",
  "memory_nodes",
  "messages",
  "missions",
  "passkeys",
  "plans",
  "policies",
  "projects",
  "ratings",
  "reviews",
  "scores",
  "sessions",
  "tasks",
  "users",
  "vault_secrets",
  "verifications",
  "workspaces",
];

describe.skipIf(!hasTestDatabase)("database", () => {
  let t: TestDb;
  let missionId: string;

  beforeAll(async () => {
    t = await createTestDb();
    await seedDemo(t.db);
    const [m] = await t.db
      .insert(missions)
      .values({ workspaceId: DEMO.workspaceId, title: "t", goal: "g" })
      .returning({ id: missions.id });
    missionId = m!.id;
  });
  afterAll(async () => t?.drop());

  const pgError = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      const err = e as { code?: string; cause?: { code?: string; message?: string }; message: string };
      return { code: err.code ?? err.cause?.code, message: err.cause?.message ?? err.message };
    }
    throw new Error("expected the statement to fail");
  };

  it("migrates an empty database to every table in ARCHITECTURE §3", async () => {
    const rows = await t.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    expect(rows.rows.map((r) => r.table_name).sort()).toEqual([...EXPECTED_TABLES].sort());
  });

  it("has pgvector installed", async () => {
    const rows = await t.db.execute(sql`select 1 from pg_extension where extname = 'vector'`);
    expect(rows.rowCount).toBe(1);
  });

  it("seeding is idempotent", async () => {
    await seedDemo(t.db);
    const m = await t.db.select().from(members).where(eq(members.workspaceId, DEMO.workspaceId));
    expect(m).toHaveLength(1);
    expect(m[0]?.role).toBe("owner");
    const [w] = await t.db.select().from(workspaces).where(eq(workspaces.id, DEMO.workspaceId));
    expect(w).toMatchObject({ slug: "demo", plan: "free", settings: {} });
  });

  describe.each([
    [
      "events",
      () => ({
        table: events,
        row: {
          workspaceId: DEMO.workspaceId,
          missionId,
          seq: 1,
          type: "mission.created",
          actor: "system",
          payload: {},
        },
      }),
    ],
    [
      "ledger",
      () => ({
        table: ledger,
        row: {
          workspaceId: DEMO.workspaceId,
          seq: 1,
          prevHash: "0".repeat(64),
          hash: "a".repeat(64),
          kind: "dispatch" as const,
          payload: {},
        },
      }),
    ],
  ])("%s is append-only", (name, make) => {
    let rowId: string;
    beforeAll(async () => {
      const { table, row } = make();
      const [r] = await t.db
        .insert(table)
        .values(row as never)
        .returning({ id: table.id });
      rowId = r!.id;
    });

    it("blocks UPDATE", async () => {
      const err = await pgError(
        t.db.execute(sql`update ${sql.identifier(name)} set payload = '{"x":1}' where id = ${rowId}`),
      );
      expect(err).toMatchObject({ code: "BR001" });
      expect(err.message).toContain("append-only");
    });
    it("blocks DELETE", async () => {
      expect(
        await pgError(t.db.execute(sql`delete from ${sql.identifier(name)} where id = ${rowId}`)),
      ).toMatchObject({ code: "BR001" });
    });
    it("blocks TRUNCATE", async () => {
      expect(await pgError(t.db.execute(sql`truncate ${sql.identifier(name)}`))).toMatchObject({
        code: "BR001",
      });
    });
  });

  it("rejects a duplicate seq within a mission", async () => {
    const row = {
      workspaceId: DEMO.workspaceId,
      missionId,
      seq: 99,
      type: "task.ready",
      actor: "system",
      payload: {},
    };
    await t.db.insert(events).values(row);
    expect(await pgError(t.db.insert(events).values(row))).toMatchObject({ code: "23505" });
  });

  it("enforces exactly one message recipient", async () => {
    const base = { workspaceId: DEMO.workspaceId, missionId, kind: "note" as const, body: "hi" };
    await t.db.insert(messages).values({ ...base, toUser: true });
    expect(await pgError(t.db.insert(messages).values({ ...base, toUser: false }))).toMatchObject({
      code: "23514",
    });
  });

  it("generates time-ordered uuid v7 ids", async () => {
    const [a] = await t.db
      .insert(workspaces)
      .values({ name: "a", slug: `a-${uuidv7().slice(-6)}` })
      .returning();
    const [b] = await t.db
      .insert(workspaces)
      .values({ name: "b", slug: `b-${uuidv7().slice(-6)}` })
      .returning();
    expect(a!.id[14]).toBe("7");
    expect(a!.id < b!.id).toBe(true);
  });
});
