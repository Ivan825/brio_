import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().min(1),
  /** The browser-facing origin. The web app proxies /api and /v1 here, so auth cookies are first-party. */
  APP_URL: z.url().default("http://localhost:3000"),
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters (openssl rand -base64 32)"),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /**
   * SSE connections are closed after this long; the browser reconnects with Last-Event-ID and resumes. Keeps
   * connections fresh behind proxies and load balancers that cut long-lived streams.
   */
  BRIO_SSE_MAX_CONNECTION_MS: z.coerce.number().int().min(1000).default(300_000),
  /** Exposes GET /v1/dev/outbox with locally "sent" emails. Never in production. */
  BRIO_DEV_OUTBOX: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type Config = z.infer<typeof Env> & { google: { clientId: string; clientSecret: string } | null };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid environment: ${issues}`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === "production" && c.BRIO_DEV_OUTBOX)
    throw new Error("BRIO_DEV_OUTBOX must not be enabled in production");
  const google =
    c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET
      ? { clientId: c.GOOGLE_CLIENT_ID, clientSecret: c.GOOGLE_CLIENT_SECRET }
      : null;
  return { ...c, google };
}
