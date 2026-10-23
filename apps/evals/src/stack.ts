// An in-process Brio for eval runs: the API (with its orchestrator) and a runner on a fresh database, exactly as
// `pnpm dev` runs them, plus a signed-in HTTP client. Torn down after the run.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { type FetchLike, redactingLogger } from "@brio/adapters";
import { type BrioServer, buildServer, loadConfig } from "@brio/api";
import { EventWriter } from "@brio/db";
import { createTestDb, type TestDb } from "@brio/db/testing";
import { Ledger } from "@brio/governance";
import { DEFAULT_IMAGES, type ImageSet, Runner, startQueue } from "@brio/runner";
import { LocalKeyProvider, Redactor } from "@brio/vault";

const APP_URL = "http://localhost:3000";

export interface Stack {
  server: BrioServer;
  runner: Runner;
  db: TestDb;
  runnerDir: string;
  images: ImageSet;
  close: () => Promise<void>;
}

export async function startStack(opts: { fetch?: FetchLike; offline: boolean }): Promise<Stack> {
  const db = await createTestDb();
  const redactor = new Redactor();
  const quiet = new Writable({ write: (_c, _e, cb) => cb() });
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: db.url,
    APP_URL,
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64"),
    BRIO_DEV_OUTBOX: "true",
    LOG_LEVEL: "warn",
    BRIO_PRICING_REFRESH_HOURS: "0",
  });
  const server = await buildServer({
    config,
    database: db,
    logDestination: quiet,
    redactor,
    keyProvider: LocalKeyProvider.fromBase64(randomBytes(32).toString("base64")),
    // Offline, every vendor host is simulated: resolve them without DNS so the URL guard still runs.
    ...(opts.offline ? { resolve: async () => ["203.0.113.10"] } : {}),
    sweepMs: 500,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const runnerDir = await mkdtemp(join(tmpdir(), "brio-evals-runner-"));
  const boss = await startQueue(db.url);
  const runner = new Runner({
    db: db.db,
    databaseUrl: db.url,
    boss,
    events: new EventWriter(redactor),
    ledger: new Ledger(redactor),
    vault: server.ctx.vault,
    redactor,
    fetch: server.ctx.fetch,
    log: redactingLogger(() => {}, redactor),
    dir: runnerDir,
    images: DEFAULT_IMAGES,
    concurrency: 4,
  });
  await runner.start();
  return {
    server,
    runner,
    db,
    runnerDir,
    images: DEFAULT_IMAGES,
    close: async () => {
      await runner.stop();
      await boss.stop({ graceful: false }).catch(() => {});
      await server.close();
      await db.drop();
      await rm(runnerDir, { recursive: true, force: true });
    },
  };
}

/** A browser-ish client on the in-process API: keeps cookies, sends the app's Origin. */
export class Client {
  private readonly cookies = new Map<string, string>();
  constructor(private readonly server: BrioServer) {}

  async request(method: "GET" | "POST", url: string, body?: unknown) {
    const res = await this.server.app.inject({
      method,
      url,
      headers: {
        origin: APP_URL,
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    for (const c of ([] as string[]).concat(
      (res.headers["set-cookie"] as string | string[] | undefined) ?? [],
    )) {
      const [pair] = c.split(";");
      const i = (pair ?? "").indexOf("=");
      const name = (pair ?? "").slice(0, i);
      const value = (pair ?? "").slice(i + 1);
      if (value === "" || /max-age=0/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    if (res.statusCode >= 400)
      throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body.slice(0, 500)}`);
    return res.json() as Record<string, unknown>;
  }

  /** Magic-link sign-in through the local outbox. */
  async signIn(email: string) {
    await this.request("POST", "/api/auth/sign-in/magic-link", { email, callbackURL: "/missions" });
    const outbox = await this.server.app.inject({
      method: "GET",
      url: `/v1/dev/outbox?email=${encodeURIComponent(email)}`,
    });
    const link = (outbox.json().messages as { link: string }[]).at(-1)?.link;
    if (!link) throw new Error("no sign-in link");
    const u = new URL(link);
    await this.server.app
      .inject({ method: "GET", url: `${u.pathname}${u.search}`, headers: { origin: APP_URL } })
      .then((r) => {
        for (const c of ([] as string[]).concat(
          (r.headers["set-cookie"] as string | string[] | undefined) ?? [],
        )) {
          const [pair] = c.split(";");
          const i = (pair ?? "").indexOf("=");
          this.cookies.set((pair ?? "").slice(0, i), (pair ?? "").slice(i + 1));
        }
      });
  }
}
