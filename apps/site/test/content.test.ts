// The site makes claims about Brio; these keep them true. Agent names must be connectors Brio has, numbers must be the
// load test's, names of modes, task types, checks and tools must be the code's own, every documentation page must be a
// file in docs/, and every link inside the site must reach a page and an anchor that exist.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENTS,
  CLI,
  CLI_START,
  CONNECTOR_COUNT,
  HOSTING,
  LINKS,
  MEASURED,
  NPM,
  REPO,
  SERVER_START,
  SHOTS,
  START,
} from "../lib/content";
import { DOCS, docBySlug, renderDoc, renderMarkdown, resolveDocLink } from "../lib/docs";
import { CHAT_MODES, CHECK_KINDS, MCP_TOOLS, MODES, TASK_GROUPS } from "../lib/product";
import { byCategory, CATEGORIES, connectors } from "../lib/registry";
import { PAGES, sitePaths } from "../lib/routes";

const root = new URL("../../../", import.meta.url);
const site = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const registry = (JSON.parse(read("registry/connectors.json")) as { connectors: Array<{ name: string }> })
  .connectors;
/** The string literals in a TypeScript source's first `z.enum([...])` or `[...] as const` after `marker`. */
const listAfter = (source: string, marker: string) => {
  const from = source.indexOf(marker);
  const body = source.slice(from, source.indexOf("]", from));
  return [...body.matchAll(/"([a-z0-9_.]+)"/g)].map((m) => m[1]);
};

describe("the site's claims", () => {
  it("names only agents in the connector registry, and counts them right", () => {
    const names = new Set(registry.map((c) => c.name));
    for (const agent of AGENTS) expect(names, agent).toContain(agent);
    expect(CONNECTOR_COUNT).toBe(registry.length);
  });

  it("quotes the load test's measured numbers", () => {
    const report = read("docs/LOAD_TEST.md");
    for (const m of MEASURED) expect(report, m.label).toContain(m.source);
  });

  it("links only to pages and documents that exist", () => {
    const paths = sitePaths();
    for (const [name, url] of Object.entries(LINKS)) {
      if (url.startsWith("/")) expect(paths.has(url), `${name}: ${url}`).toBe(true);
      else if (url.startsWith(`${REPO}/blob/main/`))
        expect(existsSync(new URL(url.replace(`${REPO}/blob/main/`, ""), root)), name).toBe(true);
      else expect(url.startsWith(REPO), name).toBe(true);
    }
  });

  it("gives the self-host commands the guide gives", () => {
    const guide = read("docs/SELF_HOST.md");
    expect(guide).toContain("./setup.sh");
    expect(guide).toContain("docker compose up -d");
    expect(START[0]).toContain(`${REPO}.git`);
  });

  it("describes only CLI commands the CLI has", () => {
    const usage = read("apps/cli/src/commands.ts");
    for (const [cmd] of CLI) expect(usage, cmd).toContain(cmd.replace(' "<goal>"', ""));
  });

  it("installs the CLI by the name it is published under, and shows only commands it has", () => {
    expect(read("apps/cli/scripts/pack.mjs")).toContain(`NPM_NAME = "${NPM.name}"`);
    expect(NPM.install).toBe(`npm install -g ${NPM.name}`);
    expect(NPM.page).toBe(`https://www.npmjs.com/package/${NPM.name}`);
    const usage = read("apps/cli/src/commands.ts");
    expect(CLI_START[0]).toContain(NPM.install);
    for (const line of CLI_START.slice(1))
      expect(usage, line).toContain(line.split(" ").slice(0, 2).join(" "));
  });

  it("shows only screenshots that exist", () => {
    for (const s of SHOTS)
      expect(existsSync(new URL(`../public/shots/${s.file}.jpg`, import.meta.url)), s.file).toBe(true);
  });

  it("gives the server steps the cloud guide gives, and links each hosting option to its guide", () => {
    const guide = read("docs/DEPLOY_CLOUD.md");
    const shown = SERVER_START.join("\n");
    for (const step of [
      "curl -fsSL https://get.docker.com | sudo sh",
      "sudo usermod -aG docker $USER",
      "git clone https://github.com/Ivan825/brio_.git brio",
      "./setup.sh https://",
      "--prebuilt",
      "BRIO_SIGNUP_ALLOW",
      "docker compose pull",
      "docker compose up -d",
    ]) {
      expect(shown, step).toContain(step);
      expect(guide, step).toContain(step);
    }
    for (const h of HOSTING) expect(LINKS[h.link]).toMatch(/^\/docs\/[a-z-]+$/);
  });
});

describe("what the pages say about how Brio works", () => {
  it("lists every task type, and only those, by the taxonomy's names", () => {
    const types = listAfter(read("packages/schema/src/taxonomy.ts"), "TASK_TYPES = [");
    expect(TASK_GROUPS.flatMap((g) => g.types).sort()).toEqual([...types].sort());
  });

  it("describes every execution mode, and chat runs only real ones", () => {
    const modes = listAfter(read("packages/schema/src/missions.ts"), "ExecutionMode = z.enum([");
    expect(MODES.map((m) => m.mode).sort()).toEqual([...modes].sort());
    for (const c of CHAT_MODES) expect(modes, c.key).toContain(c.mode);
  });

  it("explains every acceptance check kind, and only those", () => {
    const kinds = listAfter(read("packages/schema/src/contract.ts"), "AcceptanceCheckKind = z.enum([");
    expect(CHECK_KINDS.map(([k]) => k).sort()).toEqual([...kinds].sort());
  });

  it("lists every tool of Brio's MCP server, and only those", () => {
    const server = read("apps/api/src/mcp/server.ts");
    const tools = [...server.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(MCP_TOOLS.map(([t]) => t).sort()).toEqual([...tools].sort());
  });

  it("files every connector under a category docs/CONNECTORS.md has", () => {
    const keys = new Set(CATEGORIES.map((c) => c.key));
    for (const c of connectors()) expect(keys, c.name).toContain(c.category);
    expect(byCategory().reduce((n, c) => n + c.names.length, 0)).toBe(CONNECTOR_COUNT);
    const headings = read("docs/CONNECTORS.md");
    for (const c of CATEGORIES) expect(headings, c.label).toContain(`## ${c.label}`);
  });
});

describe("the docs section", () => {
  it("publishes files that exist, each once", () => {
    expect(new Set(DOCS.map((d) => d.slug)).size).toBe(DOCS.length);
    expect(new Set(DOCS.map((d) => d.file)).size).toBe(DOCS.length);
    for (const d of DOCS) expect(existsSync(new URL(`docs/${d.file}`, root)), d.file).toBe(true);
  });

  it("publishes every guide people need", () => {
    for (const file of [
      "GETTING_STARTED.md",
      "OWNER_SETUP.md",
      "DEPLOY_CLOUD.md",
      "SELF_HOST.md",
      "CONNECTORS.md",
      "API.md",
      "ADAPTERS.md",
      "ADAPTER_SPEC.md",
      "ARCHITECTURE.md",
      "ROUTING_AND_QUALITY.md",
      "HANDOFF_PACKET.md",
      "SECURITY_GOVERNANCE.md",
    ])
      expect(DOCS.map((d) => d.file)).toContain(file);
  });

  it("keeps links between docs on the site, and every one reaches a heading that exists", () => {
    const ids = new Map(DOCS.map((d) => [d.slug as string, new Set(renderDoc(d.slug).ids)]));
    const broken: string[] = [];
    for (const d of DOCS) {
      const { html } = renderDoc(d.slug);
      for (const m of html.matchAll(/href="([^"]+)"/g)) {
        const href = (m[1] ?? "").replaceAll("&amp;", "&");
        if (/\.md(#|$)/.test(href) && !href.startsWith("http"))
          broken.push(`${d.slug}: ${href} (raw .md link)`);
        if (href.startsWith("#") && !ids.get(d.slug)?.has(href.slice(1))) broken.push(`${d.slug}: ${href}`);
        if (href.startsWith("/docs/")) {
          const [slug = "", anchor] = href.slice("/docs/".length).split("#");
          if (!ids.has(slug) || (anchor && !ids.get(slug)?.has(anchor))) broken.push(`${d.slug}: ${href}`);
        }
        if (href.startsWith(`${REPO}/blob/main/`)) {
          const path = href.slice(`${REPO}/blob/main/`.length).split("#")[0] ?? "";
          if (!existsSync(new URL(path, root))) broken.push(`${d.slug}: ${href} (no such file)`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("gives headings GitHub's anchors, so links written for GitHub work here", () => {
    const { ids, toc } = renderMarkdown(
      "## 2. Kubernetes with Helm (about 25 minutes)\n## Images & media\n## Images & media\n### `code` in it",
    );
    expect(ids).toEqual([
      "2-kubernetes-with-helm-about-25-minutes",
      "images--media",
      "images--media-1",
      "code-in-it",
    ]);
    expect(toc.map((t) => t.depth)).toEqual([2, 2, 2, 3]);
  });

  it("shows raw HTML as text and never makes a script link", () => {
    const { html } = renderMarkdown(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[x](javascript:alert(1)) [y](JAVASCRIPT:alert(1))',
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html.toLowerCase()).not.toContain('href="javascript:');
  });

  it("sends links to the rest of the repository to GitHub", () => {
    expect(resolveDocLink("SELF_HOST.md#5-backup-and-restore")).toEqual({
      href: "/docs/self-host#5-backup-and-restore",
      external: false,
    });
    expect(resolveDocLink("../registry/connectors.json").href).toBe(
      `${REPO}/blob/main/registry/connectors.json`,
    );
    expect(resolveDocLink("vendors/media.md").href).toBe(`${REPO}/blob/main/docs/vendors/media.md`);
    expect(docBySlug("getting-started")?.file).toBe("GETTING_STARTED.md");
  });
});

describe("links in the site's own pages", () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? sources(full) : /\.tsx?$/.test(name) ? [full] : [];
    });
  const files = ["app", "components", "lib"].flatMap((d) => sources(new URL(d, site).pathname));

  it("point only at pages the site has, and at sections those pages have", () => {
    const paths = sitePaths();
    const broken: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/(?:href=|href: )"(\/[^"]*)"/g)) {
        const [path = "", anchor] = (m[1] ?? "").split("#");
        if (path.startsWith("/shots/") || path.startsWith("/brand/")) continue;
        const sections = paths.get(path);
        if (!sections) broken.push(`${file}: ${m[1]}`);
        else if (anchor && !sections.includes(anchor) && !renderedIds(path).has(anchor))
          broken.push(`${file}: ${m[1]}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("give every page the sections it says it has", () => {
    for (const page of Object.values(PAGES)) {
      const source = readFileSync(new URL(page.file, site), "utf8");
      for (const id of page.sections)
        expect(source, `${page.path}#${id}`).toMatch(new RegExp(`id(=|: )"${id}"`));
    }
  });
});

function renderedIds(path: string): Set<string> {
  const slug = path.startsWith("/docs/") ? path.slice("/docs/".length) : "";
  return docBySlug(slug) ? new Set(renderDoc(slug).ids) : new Set();
}
