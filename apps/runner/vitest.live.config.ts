import { defineConfig } from "vitest/config";

try {
  process.loadEnvFile(new URL("../../.env", import.meta.url));
} catch {
  // no .env: the shell provides keys
}

// Live tests against real vendors with your own keys; never part of `pnpm test`.
export default defineConfig({ test: { include: ["test/live-cli.test.ts"], testTimeout: 1_800_000 } });
