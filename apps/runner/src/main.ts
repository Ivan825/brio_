import { createServer } from "node:http";
import { guardedFetch, redactingLogger } from "@brio/adapters";
import { createDb, EventWriter } from "@brio/db";
import { Ledger } from "@brio/governance";
import { keyProviderFromEnv, redactor, Vault } from "@brio/vault";
import { loadRunnerConfig } from "./config";
import { dockerAvailable } from "./docker";
import { DEFAULT_IMAGES } from "./images";
import { startQueue } from "./queue";
import { Runner } from "./runner";

const config = loadRunnerConfig();
const levels = ["debug", "info", "warn", "error"] as const;
const log = redactingLogger((level, obj, msg) => {
  if (levels.indexOf(level) < levels.indexOf(config.LOG_LEVEL)) return;
  process.stdout.write(
    `${JSON.stringify({ level, time: new Date().toISOString(), ...obj, ...(msg ? { msg } : {}) })}\n`,
  );
}, redactor);

if (!(await dockerAvailable()))
  log.warn({}, "Docker is not reachable: attempts that need a sandbox will fail");

const handle = createDb(config.DATABASE_URL);
const boss = await startQueue(config.DATABASE_URL);
const runner = new Runner({
  db: handle.db,
  databaseUrl: config.DATABASE_URL,
  boss,
  events: new EventWriter(redactor),
  ledger: new Ledger(redactor),
  vault: new Vault(
    keyProviderFromEnv({
      BRIO_KMS_PROVIDER: config.BRIO_KMS_PROVIDER,
      BRIO_VAULT_LOCAL_KEK: config.BRIO_VAULT_LOCAL_KEK,
      BRIO_AWS_KMS_KEY_ID: config.BRIO_AWS_KMS_KEY_ID,
    }),
    redactor,
  ),
  redactor,
  fetch: guardedFetch(globalThis.fetch, {
    allowPrivate: config.allowPrivateUrls,
    allowHttp: config.allowPrivateUrls,
  }),
  log,
  dir: config.BRIO_RUNNER_DIR,
  githubApiUrl: config.BRIO_GITHUB_API_URL,
  images: {
    base: config.BRIO_IMAGE_BASE ?? DEFAULT_IMAGES.base,
    cli: config.BRIO_IMAGE_CLI ?? DEFAULT_IMAGES.cli,
    proxy: config.BRIO_IMAGE_PROXY ?? DEFAULT_IMAGES.proxy,
    web: config.BRIO_IMAGE_WEB ?? DEFAULT_IMAGES.web,
    browser: config.BRIO_IMAGE_BROWSER ?? DEFAULT_IMAGES.browser,
  },
  concurrency: config.BRIO_RUNNER_CONCURRENCY,
  mailboxPort: config.BRIO_RUNNER_MAILBOX_PORT,
});
await runner.start();
await runner.reap();

const health = config.BRIO_RUNNER_HEALTH_PORT
  ? createServer((req, res) => {
      if (req.url !== "/health") return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, runner: runner.id, active: runner.active.length }));
    }).listen(config.BRIO_RUNNER_HEALTH_PORT, "127.0.0.1")
  : null;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info({ signal }, "runner shutting down");
    health?.close();
    void runner
      .stop()
      .then(() => boss.stop())
      .then(() => handle.close())
      .then(() => process.exit(0));
  });
}
