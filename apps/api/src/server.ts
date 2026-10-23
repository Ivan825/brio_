import { createDb, type DbHandle, EventFeed, EventWriter } from "@brio/db";
import { Ledger } from "@brio/governance";
import { redactor as defaultRedactor, type Redactor, redactingStream } from "@brio/vault";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { createAuth } from "./auth";
import type { Config } from "./config";
import type { AppContext } from "./context";
import { HttpError } from "./http";
import { LogMailer } from "./mailer";
import { authRoutes } from "./routes/auth";
import { devRoutes } from "./routes/dev";
import { healthRoutes } from "./routes/health";
import { missionRoutes } from "./routes/missions";
import { workspaceRoutes } from "./routes/workspaces";

export interface BuildOptions {
  config: Config;
  /** Defaults to a pool on config.DATABASE_URL. */
  database?: DbHandle;
  /** Where logs go (always through the redactor). Defaults to stdout. */
  logDestination?: NodeJS.WritableStream;
  redactor?: Redactor;
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
}: BuildOptions): Promise<BrioServer> {
  const handle = database ?? createDb(config.DATABASE_URL);
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

  const mailer = new LogMailer();
  mailer.attachLogger(app.log);
  const ledger = new Ledger(redactor);
  const feed = new EventFeed(handle.pool);
  await feed.start();

  const ctx: AppContext = {
    config,
    db: handle.db,
    auth: createAuth({ db: handle.db, config, mailer, ledger }),
    events: new EventWriter(redactor),
    feed,
    ledger,
    mailer,
  };

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
  await authRoutes(app, ctx);
  await workspaceRoutes(app, ctx);
  await missionRoutes(app, ctx);
  if (config.BRIO_DEV_OUTBOX && config.NODE_ENV !== "production") await devRoutes(app, ctx);

  return {
    app,
    ctx,
    close: async () => {
      await app.close();
      await feed.stop();
      if (ownsDb) await handle.close();
    },
  };
}
