// After `next build`: every link inside the site must reach a page, file or anchor that the build produced.
// Fails the build with the list of broken links, so a renamed heading or page cannot leave a dead link behind.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../out");

function htmlFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "_next" ? [] : htmlFiles(full);
    return name.endsWith(".html") ? [full] : [];
  });
}

const decode = (s) => s.replaceAll("&amp;", "&").replaceAll("&quot;", '"');
const ids = new Map();
const idsOf = (file) => {
  if (!ids.has(file)) {
    const html = readFileSync(file, "utf8");
    ids.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => decode(m[1]))));
  }
  return ids.get(file);
};

/** The built file a site path is served from, if any. */
function target(path) {
  const clean = decodeURIComponent(path.replace(/\/$/, "")) || "/";
  const candidates =
    clean === "/"
      ? ["index.html"]
      : [`${clean}.html`, `${clean}/index.html`, clean].map((p) => p.replace(/^\//, ""));
  return candidates.map((c) => join(out, c)).find((f) => existsSync(f) && statSync(f).isFile());
}

const broken = [];
const pages = htmlFiles(out);
for (const page of pages) {
  const html = readFileSync(page, "utf8");
  for (const m of html.matchAll(/\shref="([^"]+)"/g)) {
    const href = decode(m[1]);
    if (/^(https?:|mailto:)/.test(href) || href.startsWith("//")) continue;
    const [path, hash] = href.split("#");
    const file = path ? target(path) : page;
    if (!file) {
      broken.push(`${relative(out, page)}: ${href} (no such page or file)`);
      continue;
    }
    if (hash && file.endsWith(".html") && !idsOf(file).has(hash))
      broken.push(`${relative(out, page)}: ${href} (no #${hash} there)`);
  }
}

if (broken.length) {
  console.error(`${broken.length} broken link(s):\n${[...new Set(broken)].join("\n")}`);
  process.exit(1);
}
console.log(`links: ${pages.length} pages, every internal link resolves`);
