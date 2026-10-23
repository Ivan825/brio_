// Throwaway databases for integration tests: each call creates a fresh, migrated database and drops it afterwards.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createDb, type DbHandle } from "./client";
import { runMigrations } from "./migrate";

export function testServerUrl(): string | undefined {
  return process.env.TEST_DATABASE_URL;
}

/** True when integration tests can run. CI always sets TEST_DATABASE_URL. */
export const hasTestDatabase = Boolean(testServerUrl());

export interface TestDb extends DbHandle {
  url: string;
  drop: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const server = testServerUrl();
  if (!server)
    throw new Error("TEST_DATABASE_URL is not set; run `docker compose up -d` and see .env.example");
  const name = `brio_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: server });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();

  const url = new URL(server);
  url.pathname = `/${name}`;
  const handle = createDb(url.toString(), { max: 5 });
  await runMigrations(handle.db);

  return {
    ...handle,
    url: url.toString(),
    drop: async () => {
      await handle.close();
      const c = new pg.Client({ connectionString: server });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    },
  };
}
