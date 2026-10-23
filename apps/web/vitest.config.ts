import { defineConfig } from "vitest/config";
import { ownCache } from "../../vitest.shared";

export default defineConfig({
  test: {
    fsModuleCachePath: ownCache(import.meta.url),
    exclude: ["e2e/**", "node_modules/**", ".next/**"],
  },
});
