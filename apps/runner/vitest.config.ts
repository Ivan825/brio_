import { defineConfig } from "vitest/config";
import { ownCache } from "../../vitest.shared";

try {
  process.loadEnvFile(new URL("../../.env", import.meta.url));
} catch {
  // no .env: CI provides the environment
}

export default defineConfig({
  test: {
    fsModuleCachePath: ownCache(import.meta.url),
    testTimeout: 120_000,
    hookTimeout: 180_000,
    exclude: ["**/node_modules/**", "test/live-cli.test.ts"],
  },
});
