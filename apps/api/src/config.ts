import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().min(1),
  /**
   * What this API process does: "all" (one process: requests and running missions), or, to scale requests apart from
   * the one process that runs missions, "web" (REST, live events, MCP, A2A and local runners' connections; as many as
   * you like) and "worker" (the orchestrator, budget guard, notifications, memory, Mandate; exactly one).
   */
  BRIO_API_ROLE: z.enum(["all", "web", "worker"]).default("all"),
  /**
   * Proxies in front of the API whose X-Forwarded-For is believed (Caddy, an ingress, the web app: 1). The client's
   * address — what sign-in rate limits key on — is the one the last trusted proxy saw. 0 when nothing is in front.
   */
  BRIO_TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),
  /**
   * The billing hook (D-105): where the worker sends each workspace's daily usage, signed with the secret (HMAC-SHA256),
   * for an operator that charges for hosting Brio. Off unless both are set.
   */
  BRIO_BILLING_WEBHOOK_URL: z.url().optional(),
  BRIO_BILLING_WEBHOOK_SECRET: z.string().min(32).optional(),
  /** Requests a client address may make each minute (live event streams and runners' sockets aside); 0: no limit. */
  BRIO_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).default(1200),
  /** Connections the API keeps to Postgres: the orchestrator, live event streams and requests share them. */
  DATABASE_POOL_MAX: z.coerce.number().int().min(2).max(500).default(20),
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
  /** Lets projects point at local repository paths (the runner clones them from its disk). Defaults to on outside production. */
  BRIO_ALLOW_LOCAL_REPOS: z.enum(["true", "false"]).optional(),
  /** GitHub's REST API for issue links: api.github.com, or a GitHub Enterprise Server's https://host/api/v3. */
  BRIO_GITHUB_API_URL: z.url().default("https://api.github.com"),
  /** Email through Resend (sign-in links, invitations, notifications); without a key or SMTP emails are only logged. */
  RESEND_API_KEY: z.string().min(1).optional(),
  /**
   * Email through any SMTP server instead (D-106): a mailbox you already have (Gmail with an app password, Outlook,
   * Zoho) needs no domain of your own. Resend wins when both are set.
   */
  BRIO_SMTP_HOST: z.string().min(1).optional(),
  BRIO_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
  /** "implicit" (TLS from the first byte, port 465), "starttls" (upgrade, required; 587) or "none" (a local relay). */
  BRIO_SMTP_TLS: z.enum(["implicit", "starttls", "none"]).optional(),
  BRIO_SMTP_USER: z.string().min(1).optional(),
  BRIO_SMTP_PASSWORD: z.string().min(1).optional(),
  /**
   * The sender. With Resend, an address on a domain verified there; with SMTP, an address the mailbox may send as.
   * Defaults to the SMTP user, else Resend's test sender (which only reaches the Resend account's own address).
   */
  BRIO_EMAIL_FROM: z.string().min(3).optional(),
  /** Web push (VAPID): generate with `npx web-push generate-vapid-keys`; without them browser push is off. */
  BRIO_VAPID_PUBLIC_KEY: z.string().min(20).optional(),
  BRIO_VAPID_PRIVATE_KEY: z.string().min(20).optional(),
  BRIO_VAPID_SUBJECT: z.string().min(5).default("mailto:admin@example.com"),
  /** Slack's Web API (tests point it at a fake). */
  BRIO_SLACK_API_URL: z.url().default("https://slack.com/api"),
  /** Hours between live price refreshes from public sources; 0 turns the timer off. */
  BRIO_PRICING_REFRESH_HOURS: z.coerce.number().min(0).default(24),
  /** Exposes GET /v1/dev/outbox with locally "sent" emails. Never in production. */
  BRIO_DEV_OUTBOX: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export interface SmtpConfig {
  host: string;
  port: number;
  tls: "implicit" | "starttls" | "none";
  auth: { user: string; pass: string } | null;
}

export type Config = Omit<
  z.infer<typeof Env>,
  "BRIO_ALLOW_PRIVATE_URLS" | "BRIO_ALLOW_LOCAL_REPOS" | "BRIO_EMAIL_FROM"
> & {
  google: { clientId: string; clientSecret: string } | null;
  /** Who sends Brio's emails: Resend, an SMTP server, or nobody (they are only logged). */
  email: "resend" | "smtp" | "log";
  smtp: SmtpConfig | null;
  BRIO_EMAIL_FROM: string;
  allowPrivateUrls: boolean;
  allowLocalRepos: boolean;
};

/** A variable set to nothing (`RESEND_API_KEY=` in an env file) is not set. */
export const withoutBlanks = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(withoutBlanks(env));
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
  if (Boolean(c.BRIO_SMTP_USER) !== Boolean(c.BRIO_SMTP_PASSWORD))
    throw new Error("invalid environment: BRIO_SMTP_USER and BRIO_SMTP_PASSWORD go together");
  if ((c.BRIO_SMTP_USER || c.BRIO_SMTP_TLS) && !c.BRIO_SMTP_HOST)
    throw new Error("invalid environment: BRIO_SMTP_HOST is required for SMTP");
  if (c.NODE_ENV === "production" && c.BRIO_SMTP_TLS === "none" && c.BRIO_SMTP_PASSWORD)
    throw new Error("invalid environment: an SMTP password is never sent without TLS in production");
  const smtp: SmtpConfig | null = c.BRIO_SMTP_HOST
    ? {
        host: c.BRIO_SMTP_HOST,
        port: c.BRIO_SMTP_PORT,
        tls: c.BRIO_SMTP_TLS ?? (c.BRIO_SMTP_PORT === 465 ? "implicit" : "starttls"),
        auth:
          c.BRIO_SMTP_USER && c.BRIO_SMTP_PASSWORD
            ? { user: c.BRIO_SMTP_USER, pass: c.BRIO_SMTP_PASSWORD }
            : null,
      }
    : null;
  const email = c.RESEND_API_KEY ? "resend" : smtp ? "smtp" : "log";
  const from =
    c.BRIO_EMAIL_FROM ??
    (email === "smtp" && smtp?.auth?.user.includes("@")
      ? `Brio <${smtp.auth.user}>`
      : "Brio <onboarding@resend.dev>");
  const { BRIO_ALLOW_PRIVATE_URLS, BRIO_ALLOW_LOCAL_REPOS, BRIO_EMAIL_FROM: _from, ...rest } = c;
  const allowPrivateUrls =
    BRIO_ALLOW_PRIVATE_URLS === undefined ? c.NODE_ENV !== "production" : BRIO_ALLOW_PRIVATE_URLS === "true";
  const allowLocalRepos =
    BRIO_ALLOW_LOCAL_REPOS === undefined ? c.NODE_ENV !== "production" : BRIO_ALLOW_LOCAL_REPOS === "true";
  return { ...rest, BRIO_EMAIL_FROM: from, google, email, smtp, allowPrivateUrls, allowLocalRepos };
}
