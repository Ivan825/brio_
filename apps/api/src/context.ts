import type { FetchLike } from "@brio/adapters";
import type { Db, EventFeed, EventWriter } from "@brio/db";
import type { Ledger } from "@brio/governance";
import type { Redactor, Vault } from "@brio/vault";
import type { FastifyBaseLogger } from "fastify";
import type { AttemptRunner } from "./attempts";
import type { Auth } from "./auth";
import type { Config } from "./config";
import type { LogMailer } from "./mailer";
import type { PricingService } from "./pricing";

/** Everything routes need, built once in buildServer and passed explicitly (no globals). */
export interface AppContext {
  config: Config;
  db: Db;
  auth: Auth;
  events: EventWriter;
  feed: EventFeed;
  ledger: Ledger;
  mailer: LogMailer;
  vault: Vault;
  redactor: Redactor;
  /** Outbound HTTP for connectors, guarded against unsafe URLs (packages/adapters net.ts). */
  fetch: FetchLike;
  /** Throws unless a user-supplied URL may be called (same policy as fetch). */
  checkUrl: (url: string) => Promise<URL>;
  pricing: PricingService;
  attempts: AttemptRunner;
  log: FastifyBaseLogger;
}
