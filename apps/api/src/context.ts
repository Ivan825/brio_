import type { FetchLike } from "@brio/adapters";
import type { Db, EventFeed, EventWriter } from "@brio/db";
import type { Ledger } from "@brio/governance";
import type { Redactor, Vault } from "@brio/vault";
import type { FastifyBaseLogger } from "fastify";
import type { PgBoss } from "pg-boss";
import type { AttemptRunner } from "./attempts";
import type { Auth } from "./auth";
import type { BudgetGuard } from "./budgets";
import type { Config } from "./config";
import type { LogMailer, Mailer } from "./mailer";
import type { MemoryIngest } from "./memory";
import type { Notifier } from "./notify/notifier";
import type { Orchestrator } from "./orchestrator/orchestrator";
import type { PricingService } from "./pricing";
import type { RunnerHub } from "./runners/hub";

/** Everything routes need, built once in buildServer and passed explicitly (no globals). */
export interface AppContext {
  config: Config;
  db: Db;
  auth: Auth;
  events: EventWriter;
  feed: EventFeed;
  ledger: Ledger;
  mailer: Mailer;
  /** Emails kept locally (the dev outbox; every email when Resend is not configured). */
  outbox: LogMailer;
  vault: Vault;
  redactor: Redactor;
  /** Outbound HTTP for connectors, guarded against unsafe URLs (packages/adapters net.ts). */
  fetch: FetchLike;
  /** Throws unless a user-supplied URL may be called (same policy as fetch). */
  checkUrl: (url: string) => Promise<URL>;
  pricing: PricingService;
  attempts: AttemptRunner;
  /** The attempt queue (pg-boss); runners consume it. */
  queue: PgBoss;
  /** Plans missions, runs their task graphs and verifies results (ARCHITECTURE §4). */
  orchestrator: Orchestrator;
  /** Local runners connected to this API instance (M8). */
  runners: RunnerHub;
  /** Warns and stops at budgets while work runs (M9). */
  budgets: BudgetGuard;
  /** Tells people what needs them: email, browser push, Slack (M9). */
  notifier: Notifier;
  /** Builds each project's memory graph from the event log (M9). */
  memory: MemoryIngest;
  log: FastifyBaseLogger;
}
