import { defineConfig } from "vitest/config";
import { ownCache } from "../../vitest.shared";

export default defineConfig({
  test: {
    fsModuleCachePath: ownCache(import.meta.url),
    exclude: ["node_modules/**", ".next/**", "out/**"],
  },
});
