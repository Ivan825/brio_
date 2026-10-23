import { readFile } from "node:fs/promises";
export const DEFAULTS = { port: 3000 };
export async function readConfig(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
