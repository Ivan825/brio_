// Publishes the built site (out/) to Vercel as plain static files, from this machine. The repository is never
// connected to Vercel, so no GitHub App or bot touches it (CLAUDE.md rule 9). The first run asks Vercel's questions and
// remembers the project in apps/site/.vercel (not committed); later runs deploy straight to production.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERCEL = "vercel@62.7.0";
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../out");
const link = resolve(here, "../.vercel");

if (!existsSync(resolve(out, "index.html"))) {
  console.error("out/index.html is missing: run `pnpm build` first (or `pnpm run deploy`, which builds).");
  process.exit(1);
}
if (existsSync(link)) cpSync(link, resolve(out, ".vercel"), { recursive: true });

const run = spawnSync("npx", ["--yes", VERCEL, "deploy", out, "--prod"], { stdio: "inherit" });
if (existsSync(resolve(out, ".vercel"))) {
  rmSync(link, { recursive: true, force: true });
  cpSync(resolve(out, ".vercel"), link, { recursive: true });
}
process.exit(run.status ?? 1);
