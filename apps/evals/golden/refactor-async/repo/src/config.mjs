import { readFile } from "node:fs";
export const DEFAULTS = { port: 3000 };
export function readConfig(path, cb) {
  readFile(path, "utf8", (err, text) => (err ? cb(err) : cb(null, JSON.parse(text))));
}
