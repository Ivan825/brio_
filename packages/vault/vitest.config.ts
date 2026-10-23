import { defineConfig } from "vitest/config";

try {
  process.loadEnvFile(new URL("../../.env", import.meta.url));
} catch {
  // no .env: CI provides the environment
}

export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 60_000 },
});
