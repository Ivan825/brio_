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
  /** Vault key provider (packages/vault keyProviderFromEnv). */
  BRIO_KMS_PROVIDER: z.enum(["local", "aws"]).default("local"),
  BRIO_VAULT_LOCAL_KEK: z.string().optional(),
  BRIO_AWS_KMS_KEY_ID: z.string().optional(),
  /**
   * Lets connectors call loopback and private-network base URLs (local models, self-hosted proxies). Defaults to on
   * outside production. Cloud metadata addresses are always blocked.
   */
  BRIO_ALLOW_PRIVATE_URLS: z.enum(["true", "false"]).optional(),
  /** USD per unit for vendors that price in other currencies, e.g. "INR=0.0114,CNY=0.14". */
  BRIO_FX_USD_PER: z.string().optional(),
  /** Hours between live price refreshes from public sources; 0 turns the timer off. */
  BRIO_PRICING_REFRESH_HOURS: z.coerce.number().min(0).default(24),
  /** Exposes GET /v1/dev/outbox with locally "sent" emails. Never in production. */
  BRIO_DEV_OUTBOX: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type Config = Omit<z.infer<typeof Env>, "BRIO_ALLOW_PRIVATE_URLS"> & {
  google: { clientId: string; clientSecret: string } | null;
  allowPrivateUrls: boolean;
};

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
  const { BRIO_ALLOW_PRIVATE_URLS, ...rest } = c;
  const allowPrivateUrls =
    BRIO_ALLOW_PRIVATE_URLS === undefined ? c.NODE_ENV !== "production" : BRIO_ALLOW_PRIVATE_URLS === "true";
  return { ...rest, google, allowPrivateUrls };
}
