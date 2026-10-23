import { randomBytes } from "node:crypto";
import { createDb, schema } from "@brio/db";
import { Ledger } from "@brio/governance";
import { getAuthTables } from "better-auth/db";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import { loadConfig } from "../src/config";
import { LogMailer } from "../src/mailer";

const TABLES = {
  user: schema.users,
  session: schema.sessions,
  account: schema.accounts,
  verification: schema.verifications,
  passkey: schema.passkeys,
  organization: schema.workspaces,
  member: schema.members,
  invitation: schema.invitations,
} as const;

describe("Better Auth schema", () => {
  it("every field Better Auth and its plugins expect exists on our Drizzle tables", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://unused",
      BETTER_AUTH_SECRET: randomBytes(32).toString("base64"),
    });
    const { db, close } = createDb(config.DATABASE_URL);
    const auth = createAuth({ db, config, mailer: new LogMailer(), ledger: new Ledger() });
    const expected = getAuthTables(auth.options);
    void close();

    const missing: string[] = [];
    for (const [model, def] of Object.entries(expected)) {
      if (model === "rateLimit") continue; // memory storage
      const table = TABLES[model as keyof typeof TABLES];
      if (!table) {
        missing.push(`table for model ${model}`);
        continue;
      }
      const columns = getTableColumns(table);
      for (const [field, attr] of Object.entries(def.fields)) {
        const name = (attr as { fieldName?: string }).fieldName ?? field;
        if (!(name in columns)) missing.push(`${model}.${name}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
