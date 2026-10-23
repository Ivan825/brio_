import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  BRIO_KMS_PROVIDER: z.enum(["local", "aws"]).default("local"),
  BRIO_VAULT_LOCAL_KEK: z.string().optional(),
  BRIO_AWS_KMS_KEY_ID: z.string().optional(),
  BRIO_ALLOW_PRIVATE_URLS: z.enum(["true", "false"]).optional(),
  /** Worktrees, repository caches and scratch files. */
  BRIO_RUNNER_DIR: z.string().default(join(homedir(), ".brio", "runner")),
  BRIO_RUNNER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(2),
  /** Port of the mailbox MCP server sandboxes reach through their proxy (0: any free port). */
  BRIO_RUNNER_MAILBOX_PORT: z.coerce.number().int().min(0).default(0),
  /** Liveness endpoint (GET /health) for orchestrators; off when unset. */
  BRIO_RUNNER_HEALTH_PORT: z.coerce.number().int().positive().optional(),
  BRIO_IMAGE_BASE: z.string().optional(),
  BRIO_IMAGE_CLI: z.string().optional(),
  BRIO_IMAGE_PROXY: z.string().optional(),
  BRIO_IMAGE_WEB: z.string().optional(),
  BRIO_IMAGE_BROWSER: z.string().optional(),
  /** GitHub's REST API for pull requests: api.github.com, or a GitHub Enterprise Server's https://host/api/v3. */
  BRIO_GITHUB_API_URL: z.url().default("https://api.github.com"),
});

export type RunnerConfig = z.infer<typeof Env> & { allowPrivateUrls: boolean };

export function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success)
    throw new Error(
      `invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  const c = parsed.data;
  const allowPrivateUrls =
    c.BRIO_ALLOW_PRIVATE_URLS === undefined
      ? c.NODE_ENV !== "production"
      : c.BRIO_ALLOW_PRIVATE_URLS === "true";
  return { ...c, allowPrivateUrls };
}
