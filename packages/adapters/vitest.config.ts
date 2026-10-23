import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { testTimeout: 15_000, exclude: ["**/node_modules/**", "test/live.test.ts"] },
});
