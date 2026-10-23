import "./env";
import { createDb, databaseUrlFromEnv } from "../client";
import { seedDemo } from "../seed";

const { db, close } = createDb(databaseUrlFromEnv(), { max: 1 });
try {
  await seedDemo(db);
  console.log("seeded demo workspace and project");
} finally {
  await close();
}
