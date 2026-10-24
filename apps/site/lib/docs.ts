// The docs section is the repository's own Markdown, rendered when the site is built: one page per file in docs/, so
// the website and GitHub always say the same thing. Links between docs stay inside the site; links to anything else in
// the repository go to GitHub. Raw HTML in the Markdown is shown as text.
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { Marked, type Tokens } from "marked";
import { REPO } from "./content";
import { DOCS, type DocMeta, docBySlug, docHref } from "./docs-index";

export { DOC_GROUPS, DOCS, type DocGroup, type DocMeta, docBySlug, docHref } from "./docs-index";

export interface TocEntry {
  id: string;
  text: string;
  depth: 2 | 3;
}

export interface RenderedDoc {
  meta: DocMeta;
  /** The doc's own first heading. */
  title: string;
  html: string;
  toc: TocEntry[];
  /** Every heading id on the page, for links to check against. */
  ids: string[];
}

// The repository root: the site builds and tests from apps/site.
const ROOT = join(process.cwd(), "..", "..");

export const docSource = (file: string) => readFileSync(join(ROOT, "docs", file), "utf8");
export const sourceUrl = (file: string) => `${REPO}/blob/main/docs/${file}`;

const escapeHtml = (t: string) =>
  t.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** GitHub's heading anchors: lower case, punctuation dropped, each space a hyphen. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

type Inline = Tokens.Generic & { tokens?: Inline[]; text?: string };

/** A heading's text as GitHub sees it: formatting dropped, code and link text kept. */
function plain(tokens: readonly Inline[]): string {
  return tokens.map((t) => (t.tokens?.length ? plain(t.tokens) : (t.text ?? ""))).join("");
}

/**
 * Where a link in docs/<from> goes on the site: another published doc stays inside the site, an anchor stays on the
 * page, anything else in the repository goes to GitHub, and the web keeps its address.
 */
export function resolveDocLink(href: string): { href: string; external: boolean } {
  if (/^(https?:|mailto:)/i.test(href)) return { href, external: true };
  if (href.startsWith("#")) return { href, external: false };
  const [path = "", hash] = href.split("#");
  const target = posix.normalize(posix.join("docs", path));
  if (target.startsWith("..")) return { href: REPO, external: true };
  const doc = DOCS.find((d) => `docs/${d.file}` === target);
  if (doc) return { href: `${docHref(doc.slug)}${hash ? `#${hash}` : ""}`, external: false };
  return { href: `${REPO}/blob/main/${target}${hash ? `#${hash}` : ""}`, external: true };
}

function renderer(toc: TocEntry[], ids: string[]) {
  const seen = new Map<string, number>();
  type This = { parser: { parseInline(t: Tokens.Generic[]): string } };
  return new Marked({
    gfm: true,
    renderer: {
      html({ text }: Tokens.HTML | Tokens.Tag) {
        return escapeHtml(text);
      },
      heading(this: This, { tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        const text = plain(tokens as Inline[]);
        const base = slugify(text);
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        const id = n === 0 ? base : `${base}-${n}`;
        ids.push(id);
        if (depth === 2 || depth === 3) toc.push({ id, text, depth });
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${inner}</h${depth}>\n`;
      },
      link(this: This, { href, tokens }: Tokens.Link) {
        const label = this.parser.parseInline(tokens);
        const to = resolveDocLink(href);
        return to.external
          ? `<a href="${escapeHtml(to.href)}" target="_blank" rel="noreferrer noopener">${label}</a>`
          : `<a href="${escapeHtml(to.href)}">${label}</a>`;
      },
      image({ href, text }: Tokens.Image) {
        const to = resolveDocLink(href);
        return `<a href="${escapeHtml(to.href)}" target="_blank" rel="noreferrer noopener">${escapeHtml(text || href)}</a>`;
      },
      code({ text, lang }: Tokens.Code) {
        const language = (lang ?? "").split(/\s/)[0] ?? "";
        const label = language === "mermaid" ? "diagram · mermaid source" : language || "text";
        return `<div class="code-block"><div class="code-label">${escapeHtml(label)}</div><pre><code>${escapeHtml(text)}</code></pre></div>\n`;
      },
    },
  });
}

/** Renders any Markdown the way the docs pages do (used by tests on hostile input). */
export function renderMarkdown(md: string): { html: string; toc: TocEntry[]; ids: string[] } {
  const toc: TocEntry[] = [];
  const ids: string[] = [];
  const html = (renderer(toc, ids).parse(md, { async: false }) as string)
    .replaceAll("<table>", '<div class="table-wrap"><table>')
    .replaceAll("</table>", "</table></div>");
  return { html, toc, ids };
}

const cache = new Map<string, RenderedDoc>();

/** One published doc, rendered. The first heading becomes the page title, not part of the body. */
export function renderDoc(slug: string): RenderedDoc {
  const hit = cache.get(slug);
  if (hit) return hit;
  const meta = docBySlug(slug);
  if (!meta) throw new Error(`no doc ${slug}`);
  const source = docSource(meta.file);
  const first = /^#\s+(.+)$/m.exec(source);
  const title = first?.[1]?.trim() ?? meta.title;
  const body = first ? source.replace(first[0], "") : source;
  const { html, toc, ids } = renderMarkdown(body);
  const doc = { meta, title, html, toc, ids };
  cache.set(slug, doc);
  return doc;
}

/** The previous and next doc in sidebar order. */
export function neighbours(slug: string): { prev?: DocMeta; next?: DocMeta } {
  const i = DOCS.findIndex((d) => d.slug === slug);
  return { prev: i > 0 ? DOCS[i - 1] : undefined, next: i >= 0 ? DOCS[i + 1] : undefined };
}
