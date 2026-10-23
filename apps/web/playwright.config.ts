import { defineConfig, devices } from "@playwright/test";

export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3100);
export const API_PORT = Number(process.env.E2E_API_PORT ?? 4100);
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgres://brio:brio@localhost:5433/brio_e2e";
const APP_URL = `http://localhost:${WEB_PORT}`;
const API_URL = `http://localhost:${API_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: APP_URL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // fresh, migrated database, then the API with the local outbox enabled
      command: "pnpm --filter @brio/db db:reset && pnpm --filter @brio/api start",
      url: `${API_URL}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NODE_ENV: "test",
        DATABASE_URL: E2E_DATABASE_URL,
        PORT: String(API_PORT),
        HOST: "127.0.0.1",
        APP_URL,
        BETTER_AUTH_SECRET: "e2e-only-secret-0123456789abcdefghijklmnopqrstuvwxyz",
        BRIO_DEV_OUTBOX: "true",
        // rotate SSE connections quickly so the reconnect/resume path is exercised
        BRIO_SSE_MAX_CONNECTION_MS: "2000",
        LOG_LEVEL: "warn",
      },
    },
    {
      command: `pnpm build && pnpm next start --port ${WEB_PORT}`,
      url: `${APP_URL}/sign-in`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: { API_URL, APP_URL, NEXT_PUBLIC_APP_URL: APP_URL },
    },
  ],
});
