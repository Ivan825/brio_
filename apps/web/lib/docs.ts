// The documentation site (/docs): the repository's own docs/*.md, rendered at build time. Links between documents
// become links between pages; anything else in the repository links to GitHub.
import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Marked, type Tokens } from "marked";

export const REPO_URL = "https://github.com/Ivan825/brio_";

export interface DocPage {
  slug: string;
  file: string;
  title: string;
  section: "Start" | "Use" | "Extend" | "Under the hood";
  summary: string;
}

export const DOCS: readonly DocPage[] = [
  {
    slug: "getting-started",
    file: "GETTING_STARTED.md",
    title: "Getting started",
    section: "Start",
    summary: "From nothing to a finished mission in ten minutes.",
  },
  {
    slug: "self-host",
    file: "SELF_HOST.md",
    title: "Self-hosting",
    section: "Start",
    summary: "Docker Compose or Helm, every setting, backups and upgrades.",
  },
  {
    slug: "deploy-cloud",
    file: "DEPLOY_CLOUD.md",
    title: "Deploy on a cloud server",
    section: "Start",
    summary:
      "Always on, with free HTTPS and no domain: Azure for Students, or any Ubuntu server with DuckDNS.",
  },
  {
    slug: "owner-setup",
    file: "OWNER_SETUP.md",
    title: "Owner setup, no domain",
    section: "Start",
    summary:
      "Step by step with free accounts: Gmail email, a Tailscale address, Slack, push, the local runner.",
  },
  {
    slug: "connectors",
    file: "CONNECTORS.md",
    title: "Connectors",
    section: "Use",
    summary: "Every agent and model Brio can drive, and how each connects.",
  },
  {
    slug: "api",
    file: "API.md",
    title: "API reference",
    section: "Use",
    summary: "Every REST route: what it does and who may call it.",
  },
  {
    slug: "security",
    file: "SECURITY_GOVERNANCE.md",
    title: "Security and governance",
    section: "Use",
    summary: "Vendor terms, the vault, sandboxes, data routing, budgets, approvals, the ledger.",
  },
  {
    slug: "adapters",
    file: "ADAPTERS.md",
    title: "Writing an adapter",
    section: "Extend",
    summary: "Add an agent or a model Brio does not know yet.",
  },
  {
    slug: "adapter-spec",
    file: "ADAPTER_SPEC.md",
    title: "Adapter specification",
    section: "Extend",
    summary: "The AgentAdapter interface and each connector family.",
  },
  {
    slug: "handoff-packet",
    file: "HANDOFF_PACKET.md",
    title: "Handoff packets",
    section: "Extend",
    summary: "The packet agents pass to each other.",
  },
  {
    slug: "architecture",
    file: "ARCHITECTURE.md",
    title: "Architecture",
    section: "Under the hood",
    summary: "Services, the data model, and how a mission flows.",
  },
  {
    slug: "routing",
    file: "ROUTING_AND_QUALITY.md",
    title: "Routing and quality",
    section: "Under the hood",
    summary: "Planner, router, execution modes, verifier and scoreboard.",
  },
  {
    slug: "security-review",
    file: "SECURITY_REVIEW.md",
    title: "Security review",
    section: "Under the hood",
    summary: "The threat model, what was tested and what was fixed.",
  },
  {
    slug: "load-test",
    file: "LOAD_TEST.md",
    title: "Load test",
    section: "Under the hood",
    summary: "125 missions, 500 attempts: how Brio held up.",
  },
  {
    slug: "decisions",
    file: "DECISIONS.md",
    title: "Decisions",
    section: "Under the hood",
    summary: "Every design decision, with its reasons and alternatives.",
  },
  {
    slug: "changelog",
    file: "CHANGELOG.md",
    title: "Changelog",
    section: "Under the hood",
    summary: "What each milestone delivered.",
  },
];

const bySlug = new Map(DOCS.map((d) => [d.slug, d]));
const byFile = new Map(DOCS.map((d) => [d.file, d]));

export function docPage(slug: string): DocPage | undefined {
  return bySlug.get(slug);
}

/** A heading's anchor: lower case, words joined by hyphens. */
export const anchorOf = (text: string) =>
  text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");

/** Where a link inside the docs goes: another page here, a page's section, or the file on GitHub. */
export function docHref(href: string): string {
  if (/^[a-z]+:/i.test(href) || href.startsWith("#") || href.startsWith("/")) return href;
  const [path = "", hash] = href.split("#");
  const file = path.split("/").pop() ?? "";
  const target = byFile.get(file);
  if (target) return `/docs/${target.slug}${hash ? `#${hash}` : ""}`;
  const fromRoot = path.replace(/^(\.\.\/)+/, "").replace(/^\.\//, "");
  return `${REPO_URL}/blob/main/${fromRoot.startsWith("docs/") || path.startsWith("../") ? fromRoot : `docs/${fromRoot}`}${hash ? `#${hash}` : ""}`;
}

const escapeHtml = (t: string) =>
  t.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const marked = new Marked({
  gfm: true,
  renderer: {
    // Raw HTML in a document is shown as text, never rendered: the page holds only marked's own markup.
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text);
    },
    heading(
      this: { parser: { parseInline(t: Tokens.Generic[]): string } },
      { tokens, depth }: Tokens.Heading,
    ) {
      const html = this.parser.parseInline(tokens);
      return `<h${depth} id="${anchorOf(html)}">${html}</h${depth}>\n`;
    },
    link(
      this: { parser: { parseInline(t: Tokens.Generic[]): string } },
      { href, title, tokens }: Tokens.Link,
    ) {
      const to = docHref(href);
      const external = /^https?:/.test(to);
      return `<a href="${escapeHtml(to)}"${title ? ` title="${escapeHtml(title)}"` : ""}${external ? ' rel="noreferrer"' : ""}>${this.parser.parseInline(tokens)}</a>`;
    },
  },
});

/** The page's HTML, from its Markdown in the repository's docs/ (our own files, at build time). */
export function renderDoc(page: DocPage): { html: string; headings: Array<{ id: string; text: string }> } {
  const md = readFileSync(join(process.cwd(), "..", "..", "docs", page.file), "utf8");
  const html = marked.parse(md, { async: false });
  const headings = [...html.matchAll(/<h2 id="([^"]+)">(.*?)<\/h2>/g)].map((m) => ({
    id: m[1] ?? "",
    text: (m[2] ?? "").replace(/<[^>]+>/g, ""),
  }));
  return { html, headings };
}
