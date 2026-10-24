// Publishes the built site (out/) to Vercel as plain static files, from this machine. The repository is never
// connected to Vercel, so no GitHub App or bot touches it (CLAUDE.md rule 9). It asks no questions: the project is
// named by BRIO_SITE_PROJECT (default brio-site; Vercel serves it at https://<name>.vercel.app when the name is free),
// and the link Vercel creates is kept in apps/site/.vercel (not committed) for the next run.
//   npx vercel@62.7.0 login                      once
//   pnpm run deploy                              build and publish
//   BRIO_SITE_PROJECT=my-name pnpm run deploy    another project name (the first time only)
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERCEL = "vercel@62.7.0";
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../out");
const link = resolve(here, "../.vercel");
const name = (process.env.BRIO_SITE_PROJECT ?? "brio-site").toLowerCase().replace(/[^a-z0-9-]/g, "-");

if (!existsSync(join(out, "index.html"))) {
  console.error("out/index.html is missing: run `pnpm build` first (or `pnpm run deploy`, which builds).");
  process.exit(1);
}
// Vercel names a new project after its folder, so the site is published from a folder named after the project.
const stage = join(mkdtempSync(join(tmpdir(), "brio-site-")), name);
cpSync(out, stage, { recursive: true });
if (existsSync(link)) cpSync(link, join(stage, ".vercel"), { recursive: true });

const run = spawnSync("npx", ["--yes", VERCEL, "deploy", stage, "--prod", "--yes"], { stdio: "inherit" });
if (existsSync(join(stage, ".vercel"))) {
  rmSync(link, { recursive: true, force: true });
  cpSync(join(stage, ".vercel"), link, { recursive: true });
}
rmSync(dirname(stage), { recursive: true, force: true });
process.exit(run.status ?? 1);
