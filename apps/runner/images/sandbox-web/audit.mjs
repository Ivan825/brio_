// brio-audit: runs one web audit inside the web sandbox and prints its JSON on stdout.
//   brio-audit a11y       (--path <file in /work> | --url <http://127.0.0.1:…>) [--wait <seconds>]
//   brio-audit lighthouse (--path … | --url …) [--categories performance,accessibility] [--wait <seconds>]
// A --path is served from /work by a small static server on 127.0.0.1, so audits need no network. Exit code 2 means
// the audit could not run (the JSON then has an "error").
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join, normalize, resolve } from "node:path";

const require = createRequire("/opt/brio-audit/");
const ROOT = resolve(process.env.BRIO_AUDIT_ROOT ?? "/work");
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/chromium";
const FLAGS = ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"];
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function args(argv) {
  const out = { kind: argv[0] };
  for (let i = 1; i < argv.length; i += 2) out[argv[i].replace(/^--/, "")] = argv[i + 1];
  return out;
}

function fail(message) {
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(2);
}

/** Serves ROOT on 127.0.0.1; never outside it. */
function serve() {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(
      /^(\.\.[/\\])+/,
      "",
    );
    let file = join(ROOT, path);
    if (!file.startsWith(ROOT)) return void res.writeHead(403).end();
    try {
      if (statSync(file).isDirectory()) file = join(file, "index.html");
      statSync(file);
    } catch {
      return void res.writeHead(404).end();
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

async function waitFor(url, seconds) {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      // not up yet
    }
    if (Date.now() > until) fail(`${url} did not answer within ${seconds}s`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function a11y(url) {
  const puppeteer = require("puppeteer-core");
  const axeSource = require("axe-core").source;
  const browser = await puppeteer.launch({ executablePath: CHROME, args: FLAGS });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle0", timeout: 60_000 });
    await page.evaluate(axeSource);
    // axe is a global in the page once its source is evaluated above.
    const r = await page.evaluate(() => axe.run(document, { resultTypes: ["violations"] }));
    // The verdict needs the violations; the rest of axe's report is large.
    return {
      url,
      violations: r.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.slice(0, 10).map((n) => ({ target: n.target })),
      })),
    };
  } finally {
    await browser.close();
  }
}

async function lighthouse(url, categories) {
  const { default: run } = await import(require.resolve("lighthouse"));
  const chromeLauncher = await import(require.resolve("chrome-launcher"));
  const chrome = await chromeLauncher.launch({ chromePath: CHROME, chromeFlags: FLAGS });
  try {
    const result = await run(url, {
      port: chrome.port,
      output: "json",
      logLevel: "error",
      onlyCategories: categories,
    });
    const { categories: cats } = result.lhr;
    // The full report is large; the verdict needs the scores (and the failing audits for the summary).
    return {
      categories: Object.fromEntries(
        Object.entries(cats).map(([k, v]) => [k, { score: v.score, title: v.title }]),
      ),
      failing: Object.values(result.lhr.audits)
        .filter((a) => a.score !== null && a.score < 0.5 && a.scoreDisplayMode === "binary")
        .slice(0, 20)
        .map((a) => a.id),
    };
  } finally {
    await chrome.kill();
  }
}

const a = args(process.argv.slice(2));
if (a.kind !== "a11y" && a.kind !== "lighthouse")
  fail("usage: brio-audit a11y|lighthouse --path <file> | --url <url>");
let server = null;
let url = a.url;
if (!url) {
  server = await serve();
  url = `http://127.0.0.1:${server.address().port}/${(a.path ?? "index.html").replace(/^\/+/, "")}`;
} else {
  await waitFor(url, Number(a.wait ?? 60));
}
try {
  const out =
    a.kind === "a11y"
      ? await a11y(url)
      : await lighthouse(url, (a.categories ?? "performance,accessibility,best-practices,seo").split(","));
  process.stdout.write(`${JSON.stringify(out)}\n`);
} catch (err) {
  fail(String(err?.message ?? err));
} finally {
  server?.close();
}
process.exit(0);
