// Markdown from agents (chat replies), rendered in the browser. Agents' text is untrusted: raw HTML is shown as text,
// links only go to http(s) or mailto, and every link opens outside the app without a referrer.
import { Marked, type Tokens } from "marked";

const escapeHtml = (t: string) =>
  t.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const SAFE_LINK = /^(https?:|mailto:)/i;

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text);
    },
    link(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, { href, tokens }: Tokens.Link) {
      const label = this.parser.parseInline(tokens);
      if (!SAFE_LINK.test(href)) return label;
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${label}</a>`;
    },
    image({ href, text }: Tokens.Image) {
      // No remote images: they would load from anywhere an agent names. The link stays, as a link.
      return SAFE_LINK.test(href)
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${escapeHtml(text || href)}</a>`
        : escapeHtml(text);
    },
  },
});

/** Safe HTML for an agent's Markdown. */
export function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false });
}
