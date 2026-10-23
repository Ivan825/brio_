// Copies logo files from @brio/brand into public/brand so Next.js can serve them. public/brand is generated, not committed.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = resolve(here, "../../../packages/brand/logo");
const to = resolve(here, "../public/brand");
rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log(`brand assets → ${to}`);
