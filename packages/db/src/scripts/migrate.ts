import "./env";
import { createDb, databaseUrlFromEnv } from "../client";
import { runMigrations } from "../migrate";

const { db, close } = createDb(databaseUrlFromEnv(), { max: 1 });
try {
  await runMigrations(db);
  console.log("migrations applied");
} finally {
  await close();
}
