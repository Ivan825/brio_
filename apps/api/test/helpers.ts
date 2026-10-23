import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { type FetchLike, redactingLogger } from "@brio/adapters";
import { createTestDb, type TestDb } from "@brio/db/testing";
import { DEFAULT_IMAGES, Runner } from "@brio/runner";
import { LocalKeyProvider, Redactor } from "@brio/vault";
import { expect } from "vitest";
import { loadConfig } from "../src/config";
import { type BrioServer, buildServer } from "../src/server";

export const APP_URL = "http://localhost:3000";

export interface Harness {
  server: BrioServer;
  /** An in-process runner on the same database and queue, as `pnpm dev` runs one beside the API. */
  runner: Runner;
  db: TestDb;
  logs: string[];
  redactor: Redactor;
  close: () => Promise<void>;
}

export interface HarnessOptions {
  fetch?: FetchLike;
  env?: Record<string, string>;
  /** Start an in-process runner (default true). Off, attempts stay queued so the dispatch can be inspected. */
  runner?: boolean;
}

/** Every hostname resolves to a public documentation address, so the URL guard passes without real DNS. */
const publicResolver = async (host: string) => (host === "localhost" ? ["127.0.0.1"] : ["203.0.113.10"]);

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const db = await createTestDb();
  const logs: string[] = [];
  const sink = new Writable({
    write(chunk, _e, cb) {
      logs.push(String(chunk));
      cb();
    },
  });
  const redactor = new Redactor();
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: db.url,
    APP_URL,
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64"),
    BRIO_DEV_OUTBOX: "true",
    LOG_LEVEL: "info",
    BRIO_PRICING_REFRESH_HOURS: "0",
    ...opts.env,
  });
  const server = await buildServer({
    config,
    database: db,
    logDestination: sink,
    redactor,
    keyProvider: LocalKeyProvider.fromBase64(randomBytes(32).toString("base64")),
    resolve: publicResolver,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const runnerDir = await mkdtemp(join(tmpdir(), "brio-api-runner-"));
  const runner = new Runner({
    db: server.ctx.db,
    databaseUrl: db.url,
    boss: server.ctx.queue,
    events: server.ctx.events,
    ledger: server.ctx.ledger,
    vault: server.ctx.vault,
    redactor,
    fetch: server.ctx.fetch,
    log: redactingLogger((_level, obj, msg) => logs.push(JSON.stringify({ ...obj, msg })), redactor),
    dir: runnerDir,
    images: DEFAULT_IMAGES,
    heartbeatMs: 500,
    reapEveryMs: 3_600_000,
  });
  if (opts.runner !== false) await runner.start();
  return {
    server,
    runner,
    db,
    logs,
    redactor,
    close: async () => {
      await runner.stop();
      await server.close();
      await db.drop();
      await rm(runnerDir, { recursive: true, force: true });
    },
  };
}

/** A browser-ish client: keeps cookies, sends the app Origin (Better Auth CSRF check). */
export class Client {
  private readonly cookies = new Map<string, string>();
  constructor(private readonly h: Harness) {}

  get cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private keep(setCookie: string | string[] | undefined) {
    for (const c of ([] as string[]).concat(setCookie ?? [])) {
      const [pair] = c.split(";");
      const i = pair!.indexOf("=");
      const name = pair!.slice(0, i);
      const value = pair!.slice(i + 1);
      if (value === "" || /max-age=0/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const res = await this.h.server.app.inject({
      method,
      url,
      headers: {
        origin: APP_URL,
        cookie: this.cookieHeader,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    this.keep(res.headers["set-cookie"] as string | string[] | undefined);
    return res;
  }

  /** Magic-link sign-in through the local outbox, exactly as a user would click the emailed link. */
  async signIn(email: string) {
    const start = await this.request("POST", "/api/auth/sign-in/magic-link", {
      email,
      callbackURL: "/missions",
    });
    expect(start.statusCode, start.body).toBe(200);
    const outbox = await this.h.server.app.inject({
      method: "GET",
      url: `/v1/dev/outbox?email=${encodeURIComponent(email)}`,
    });
    const link = (outbox.json().messages as { link: string }[]).at(-1)!.link;
    const u = new URL(link);
    const verify = await this.request("GET", `${u.pathname}${u.search}`);
    expect([200, 302]).toContain(verify.statusCode);
    const me = await this.request("GET", "/api/auth/get-session");
    expect(me.json()?.user?.email).toBe(email);
    return me.json().user as { id: string; email: string };
  }
}
