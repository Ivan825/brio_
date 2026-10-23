import { fileURLToPath } from "node:url";

/**
 * Each package keeps its own module cache: Turborepo runs packages' tests in parallel, and vitest's default (one cache
 * at the workspace root) makes those runs race on the same directory.
 */
export const ownCache = (configUrl: string) =>
  fileURLToPath(new URL("./node_modules/.vitest-cache", configUrl));
