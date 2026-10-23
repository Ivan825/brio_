import type { Db, EventFeed, EventWriter } from "@brio/db";
import type { Ledger } from "@brio/governance";
import type { Auth } from "./auth";
import type { Config } from "./config";
import type { LogMailer } from "./mailer";

/** Everything routes need, built once in buildServer and passed explicitly (no globals). */
export interface AppContext {
  config: Config;
  db: Db;
  auth: Auth;
  events: EventWriter;
  feed: EventFeed;
  ledger: Ledger;
  mailer: LogMailer;
}
