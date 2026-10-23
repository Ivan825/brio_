import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3100);
export const API_PORT = Number(process.env.E2E_API_PORT ?? 4100);
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgres://brio:brio@localhost:5433/brio_e2e";
const APP_URL = `http://localhost:${WEB_PORT}`;
const API_URL = `http://localhost:${API_PORT}`;
const FAKE_VENDOR_PORT = process.env.FAKE_VENDOR_PORT ?? "4300";
const RUNNER_HEALTH_PORT = process.env.E2E_RUNNER_HEALTH_PORT ?? "4110";
// a throwaway vault key (base64 of 32 bytes) shared by the API and the runner; never use outside tests
const E2E_KEK = Buffer.alloc(32, 7).toString("base64");

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
      // a scripted OpenAI-compatible vendor, so connector flows run without real keys
      command: "node e2e/fake-vendor.mjs",
      url: `http://127.0.0.1:${FAKE_VENDOR_PORT}/health`,
      reuseExistingServer: false,
      env: { FAKE_VENDOR_PORT },
    },
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
        BRIO_VAULT_LOCAL_KEK: E2E_KEK,
        BRIO_PRICING_REFRESH_HOURS: "0",
        LOG_LEVEL: "warn",
      },
    },
    {
      // a runner beside the API, as `pnpm dev` runs one
      command: "pnpm --filter @brio/runner start",
      url: `http://127.0.0.1:${RUNNER_HEALTH_PORT}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NODE_ENV: "test",
        DATABASE_URL: E2E_DATABASE_URL,
        BRIO_VAULT_LOCAL_KEK: E2E_KEK,
        BRIO_RUNNER_HEALTH_PORT: RUNNER_HEALTH_PORT,
        BRIO_RUNNER_DIR: join(tmpdir(), "brio-e2e-runner"),
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
