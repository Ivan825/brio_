// Drops and recreates the database in DATABASE_URL, then migrates it. Refuses unless the name ends in _e2e or _test.
import "./env";
import pg from "pg";
import { createDb, databaseUrlFromEnv } from "../client";
import { runMigrations } from "../migrate";

const url = new URL(databaseUrlFromEnv());
const name = url.pathname.slice(1);
if (!/^[a-z0-9_]+_(e2e|test)$/.test(name)) {
  console.error(`refusing to reset "${name}": only databases ending in _e2e or _test`);
  process.exit(1);
}
const server = new URL(url);
server.pathname = "/postgres";
const admin = new pg.Client({ connectionString: server.toString() });
await admin.connect();
await admin.query(`drop database if exists ${name} with (force)`);
await admin.query(`create database ${name}`);
await admin.end();

const { db, close } = createDb(url.toString(), { max: 1 });
try {
  await runMigrations(db);
  console.log(`reset and migrated ${name}`);
} finally {
  await close();
}
