import { assertSafeUrl, type FetchLike, guardedFetch, type Resolver } from "@brio/adapters";
import { createDb, type DbHandle, EventFeed, EventWriter } from "@brio/db";
import { Ledger } from "@brio/governance";
import { startQueue } from "@brio/runner";
import {
  redactor as defaultRedactor,
  type KeyProvider,
  keyProviderFromEnv,
  type Redactor,
  redactingStream,
  Vault,
} from "@brio/vault";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { a2aRoutes } from "./a2a/server";
import { AttemptRunner } from "./attempts";
import { createAuth } from "./auth";
import { BudgetGuard } from "./budgets";
import type { Config } from "./config";
import type { AppContext } from "./context";
import { HttpError } from "./http";
import { LogMailer, type Mailer, ResendMailer } from "./mailer";
import { MandateSettler } from "./mandate";
import { mcpRoutes } from "./mcp/server";
import { MemoryIngest } from "./memory";
import { Notifier } from "./notify/notifier";
import { Orchestrator } from "./orchestrator/orchestrator";
import { PricingService, parseFx } from "./pricing";
import { agentRoutes } from "./routes/agents";
import { approvalRoutes } from "./routes/approvals";
import { attemptRoutes } from "./routes/attempts";
import { authRoutes } from "./routes/auth";
import { budgetRoutes } from "./routes/budgets";
import { connectorRoutes } from "./routes/connectors";
import { crewRoutes } from "./routes/crews";
import { devRoutes } from "./routes/dev";
import { evalRoutes } from "./routes/evals";
import { healthRoutes } from "./routes/health";
import { hookRoutes } from "./routes/hooks";
import { inboxRoutes } from "./routes/inbox";
import { ledgerRoutes } from "./routes/ledger";
import { mandateRoutes } from "./routes/mandate";
import { memoryRoutes } from "./routes/memory";
import { messageRoutes } from "./routes/messages";
import { missionRoutes } from "./routes/missions";
import { notificationRoutes } from "./routes/notifications";
import { oauthRoutes } from "./routes/oauth";
import { planRoutes } from "./routes/plans";
import { policyRoutes } from "./routes/policies";
import { pricingRoutes } from "./routes/pricing";
import { projectRoutes } from "./routes/projects";
import { registryRoutes } from "./routes/registry";
import { runnerRoutes } from "./routes/runners";
import { scoreboardRoutes } from "./routes/scoreboard";
import { templateRoutes } from "./routes/templates";
import { tokenRoutes } from "./routes/tokens";
import { workspaceRoutes } from "./routes/workspaces";
import { RunnerHub } from "./runners/hub";

export interface BuildOptions {
  config: Config;
  /** Defaults to a pool on config.DATABASE_URL. */
  database?: DbHandle;
  /** Where logs go (always through the redactor). Defaults to stdout. */
  logDestination?: NodeJS.WritableStream;
  redactor?: Redactor;
  /** Vault key provider. Defaults to BRIO_KMS_PROVIDER from the config. */
  keyProvider?: KeyProvider;
  /** Outbound HTTP for connectors (tests inject a fake vendor). Always wrapped by the URL guard. */
  fetch?: FetchLike;
  /** DNS resolver for the URL guard (tests use a fixed one). */
  resolve?: Resolver;
  /** How often the orchestrator sweeps active missions (default 3 s). */
  sweepMs?: number;
  /** How often Mandate requests waiting for a person are asked about again (default 30 s). */
  mandateSweepMs?: number;
}

export interface BrioServer {
  app: FastifyInstance;
  ctx: AppContext;
  close: () => Promise<void>;
}

export async function buildServer({
  config,
  database,
  logDestination = process.stdout,
  redactor = defaultRedactor,
  keyProvider,
  fetch: outbound = globalThis.fetch,
  resolve,
  sweepMs,
  mandateSweepMs,
}: BuildOptions): Promise<BrioServer> {
  const handle = database ?? createDb(config.DATABASE_URL, { max: config.DATABASE_POOL_MAX });
  const ownsDb = !database;

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      stream: redactingStream(logDestination, redactor),
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
        censor: "[redacted]",
      },
    },
    trustProxy: true,
  });

  // Emails go through Resend when it is configured (M9); the local outbox keeps a copy in development and tests.
  const outbox = new LogMailer();
  outbox.attachLogger(app.log);
  const mailer: Mailer = config.RESEND_API_KEY
    ? new ResendMailer({
        apiKey: config.RESEND_API_KEY,
        from: config.BRIO_EMAIL_FROM,
        fetch: (url, init) => outbound(url, init),
        ...(config.BRIO_DEV_OUTBOX ? { outbox } : {}),
      })
    : outbox;
  if (!config.RESEND_API_KEY && config.NODE_ENV === "production")
    app.log.warn(
      "RESEND_API_KEY is not set: emails (sign-in links, invitations, notifications) are only logged",
    );
  const ledger = new Ledger(redactor);
  const feed = new EventFeed(handle.pool);
  await feed.start();

  const vault = new Vault(
    keyProvider ??
      keyProviderFromEnv({
        BRIO_KMS_PROVIDER: config.BRIO_KMS_PROVIDER,
        BRIO_VAULT_LOCAL_KEK: config.BRIO_VAULT_LOCAL_KEK,
        BRIO_AWS_KMS_KEY_ID: config.BRIO_AWS_KMS_KEY_ID,
      }),
    redactor,
  );
  const urlPolicy = { allowPrivate: config.allowPrivateUrls, allowHttp: config.allowPrivateUrls };
  const fetch = guardedFetch(outbound, urlPolicy, resolve);
  const ctx = {
    config,
    db: handle.db,
    auth: createAuth({ db: handle.db, config, mailer, ledger }),
    events: new EventWriter(redactor),
    feed,
    ledger,
    mailer,
    outbox,
    vault,
    redactor,
    fetch,
    checkUrl: (url: string) => assertSafeUrl(url, urlPolicy, resolve),
    pricing: new PricingService(handle.db, fetch, parseFx(config.BRIO_FX_USD_PER)),
    log: app.log,
    queue: await startQueue(config.DATABASE_URL),
  } as AppContext;
  ctx.attempts = new AttemptRunner(ctx);
  // BRIO_API_ROLE: a "web" process serves people and clients; a "worker" process runs missions; "all" does both.
  const serves = config.BRIO_API_ROLE !== "worker";
  const runs = config.BRIO_API_ROLE !== "web";
  ctx.orchestrator = new Orchestrator(ctx, {
    ...(sweepMs ? { sweepMs } : {}),
    ...(runs ? {} : { passive: true }),
  });
  ctx.runners = new RunnerHub(ctx);
  ctx.budgets = new BudgetGuard(ctx);
  ctx.mandate = new MandateSettler(ctx, mandateSweepMs);
  ctx.notifier = new Notifier(ctx);
  ctx.memory = new MemoryIngest(ctx);

  await ctx.pricing.seed();
  let pricingTimer: NodeJS.Timeout | undefined;
  if (runs && config.BRIO_PRICING_REFRESH_HOURS > 0) {
    const refresh = () =>
      ctx.pricing
        .refreshFromOpenRouter(AbortSignal.timeout(30_000))
        .then((updated) => app.log.info({ updated }, "refreshed live prices"))
        .catch((err) => app.log.warn({ err: (err as Error).message }, "live price refresh failed"));
    void refresh();
    pricingTimer = setInterval(refresh, config.BRIO_PRICING_REFRESH_HOURS * 3_600_000);
    pricingTimer.unref();
  }

  await app.register(cors, { origin: [config.APP_URL], credentials: true });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: "invalid_request",
        issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    if (err instanceof HttpError)
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500)
      return reply.status(status).send({ error: "bad_request", message: (err as Error).message });
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: "internal", message: "something went wrong" });
  });

  await healthRoutes(app, ctx);
  if (serves) {
    await authRoutes(app, ctx);
    await workspaceRoutes(app, ctx);
    await missionRoutes(app, ctx);
    await registryRoutes(app, ctx);
    await connectorRoutes(app, ctx);
    await agentRoutes(app, ctx);
    await attemptRoutes(app, ctx);
    await pricingRoutes(app, ctx);
    await planRoutes(app, ctx);
    await projectRoutes(app, ctx);
    await messageRoutes(app, ctx);
    await scoreboardRoutes(app, ctx);
    await evalRoutes(app, ctx);
    await hookRoutes(app, ctx);
    await tokenRoutes(app, ctx);
    await oauthRoutes(app, ctx);
    await mcpRoutes(app, ctx);
    await a2aRoutes(app, ctx);
    await inboxRoutes(app, ctx);
    await approvalRoutes(app, ctx);
    await crewRoutes(app, ctx);
    await templateRoutes(app, ctx);
    await runnerRoutes(app, ctx);
    await budgetRoutes(app, ctx);
    await policyRoutes(app, ctx);
    await notificationRoutes(app, ctx);
    await ledgerRoutes(app, ctx);
    await memoryRoutes(app, ctx);
    await mandateRoutes(app, ctx);
    if (config.BRIO_DEV_OUTBOX && config.NODE_ENV !== "production") await devRoutes(app, ctx);
    // Local runners connect over a WebSocket on the API's own HTTP server.
    ctx.runners.attach(app.server);
    await ctx.runners.start();
  }
  if (runs) {
    ctx.orchestrator.start();
    ctx.budgets.start();
    ctx.mandate.start();
    ctx.notifier.start();
    ctx.memory.start();
  }

  return {
    app,
    ctx,
    close: async () => {
      if (pricingTimer) clearInterval(pricingTimer);
      await ctx.orchestrator.stop();
      ctx.budgets.stop();
      ctx.mandate.stop();
      ctx.notifier.stop();
      ctx.memory.stop();
      await ctx.runners.stop();
      await app.close();
      await ctx.queue.stop({ graceful: false }).catch(() => {});
      await feed.stop();
      if (ownsDb) await handle.close();
    },
  };
}
