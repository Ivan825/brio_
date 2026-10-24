#!/usr/bin/env node
// Builds the npm package `brio-orchestrator` (D-111): the CLI bundled into one file with everything it imports, the
// sandbox image sources the local runner builds from, a README and the licence. It has no dependencies, so
// `npx brio-orchestrator` and `npm install -g brio-orchestrator` give a working `brio` on any machine with Node 22.
//   node scripts/pack.mjs [outDir]              build into outDir (default: apps/cli/dist-npm)
//   node scripts/pack.mjs --publish             build, then `npm publish` it as whoever `npm login` signed in
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export const NPM_NAME = "brio-orchestrator";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(cli, "../..");

export async function pack(out = join(cli, "dist-npm")) {
  const own = JSON.parse(await readFile(join(cli, "package.json"), "utf8"));
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, "dist"), { recursive: true });
  await build({
    entryPoints: [join(cli, "src/main.ts")],
    outfile: join(out, "dist/brio.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    minify: true,
    legalComments: "linked",
    // pg loads its optional native binding only when asked to; the CLI never does.
    external: ["pg-native"],
    // Bundled CommonJS modules call require(); give the ES module one.
    banner: {
      js: '#!/usr/bin/env node\nimport { createRequire as __brioRequire } from "node:module"; const require = __brioRequire(import.meta.url);',
    },
    logLevel: "warning",
  });
  // The local runner builds its sandboxes from these (images.ts reads <dist>/../images).
  await cp(join(root, "apps/runner/images"), join(out, "images"), { recursive: true });
  await cp(join(cli, "README.md"), join(out, "README.md"));
  await cp(join(root, "LICENSE"), join(out, "LICENSE"));
  const manifest = {
    name: NPM_NAME,
    version: own.version,
    description:
      "The brio CLI: run missions across your AI agents, watch the live board, approve plans and pull requests, and turn this machine into a runner for your self-hosted Brio.",
    license: "AGPL-3.0-only",
    type: "module",
    bin: { brio: "dist/brio.mjs" },
    files: ["dist", "images", "README.md", "LICENSE"],
    engines: { node: ">=22" },
    homepage: "https://brio-orchestrator.vercel.app",
    repository: { type: "git", url: "git+https://github.com/Ivan825/brio_.git", directory: "apps/cli" },
    bugs: { url: "https://github.com/Ivan825/brio_/issues" },
    keywords: [
      "ai",
      "agents",
      "orchestrator",
      "multi-agent",
      "mcp",
      "a2a",
      "cli",
      "claude",
      "codex",
      "gemini",
    ],
  };
  await writeFile(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { out, manifest };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const publish = process.argv.includes("--publish");
  const dir = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const { out, manifest } = await pack(dir ? resolve(dir) : undefined);
  console.log(`built ${manifest.name}@${manifest.version} in ${out}`);
  if (publish) execFileSync("npm", ["publish", "--access", "public"], { cwd: out, stdio: "inherit" });
  else
    console.log(
      `try it: node ${join(out, "dist/brio.mjs")} --help   publish: pnpm --filter @brio/cli publish:npm`,
    );
}
