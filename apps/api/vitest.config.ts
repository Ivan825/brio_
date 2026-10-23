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
    exclude: ["**/node_modules/**", "test/live-*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
