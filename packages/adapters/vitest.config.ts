import { defineConfig } from "vitest/config";
import { ownCache } from "../../vitest.shared";

export default defineConfig({
  test: {
    fsModuleCachePath: ownCache(import.meta.url),
    testTimeout: 15_000,
    exclude: ["**/node_modules/**", "test/live.test.ts"],
  },
});
