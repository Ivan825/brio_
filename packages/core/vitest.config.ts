import { defineConfig } from "vitest/config";

// Own config so `vitest run` here never falls back to the repo-root workspace config.
export default defineConfig({ test: {} });
