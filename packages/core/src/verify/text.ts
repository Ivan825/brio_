// Text checks on written results (ROUTING §4.1): citation_present, and the links that link_check and fact_check
// follow. Pure.

export interface CitationResult {
  passed: boolean;
  /** The start of each factual paragraph without a source. */
  uncited: string[];
  paragraphs: number;
  summary: string;
}

const CITATION = [
  /\[\^?\d+\]/, // [1] or [^1]
  /\[[^\]]+\]\(https?:\/\/[^)\s]+\)/, // a markdown link
  /https?:\/\/\S+/, // a bare URL
  /\([A-Z][A-Za-z'’-]+(?: et al\.)?(?:,| and [A-Z][A-Za-z'’-]+,)? (?:19|20)\d{2}[a-z]?\)/, // (Author, 2020)
  /\bdoi:\s*10\.\d{4,}/i,
];

/** Paragraphs of prose: not headings, code, tables, quotes of the sources list, or very short lines. */
function proseParagraphs(text: string, minWords: number): string[] {
  const withoutCode = text.replace(/```[\s\S]*?```/g, "");
  return withoutCode
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(
      (p) =>
        p &&
        !/^#{1,6}\s/.test(p) &&
        !/^\|/.test(p) &&
        !/^(references|sources|bibliography|citations)\b/i.test(p.replace(/^[#*_\s]+/, "")) &&
        !/^\s*\[\d+\]:?\s/.test(p) &&
        p.split(/\s+/).length >= minWords,
    );
}

/** Every factual paragraph (prose of at least `minWords` words) carries a source. */
export function citationsPresent(text: string, opts: { minWords?: number } = {}): CitationResult {
  const paragraphs = proseParagraphs(text, opts.minWords ?? 25);
  const uncited = paragraphs
    .filter((p) => !CITATION.some((re) => re.test(p)))
    .map((p) => (p.length > 80 ? `${p.slice(0, 80)}…` : p));
  if (!paragraphs.length)
    return { passed: true, uncited: [], paragraphs: 0, summary: "no factual paragraphs to cite" };
  return {
    passed: uncited.length === 0,
    uncited,
    paragraphs: paragraphs.length,
    summary: uncited.length
      ? `${uncited.length} of ${paragraphs.length} paragraph(s) have no source: "${uncited[0]}"`
      : `all ${paragraphs.length} paragraph(s) cite a source`,
  };
}

/** http(s) links in markdown or plain text, de-duplicated, without trailing punctuation. */
export function extractLinks(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    try {
      out.add(new URL(url).toString());
    } catch {
      // not a URL after all
    }
  }
  return [...out];
}

/** Numbered sources (`[1]: https://…` or `[1] https://…` lines) and the claims (sentences) that cite each one. */
export function citedSources(text: string): Array<{ ref: string; url: string; claims: string[] }> {
  const sources = new Map<string, string>();
  for (const m of text.matchAll(/^\s*\[\^?(\d+)\]:?\s+(?:.*?)(https?:\/\/[^\s<>)\]]+)/gm))
    if (m[1] && m[2]) sources.set(m[1], m[2].replace(/[.,;:]+$/, ""));
  const body = text.replace(/^\s*\[\^?\d+\]:?\s+.*$/gm, "");
  const sentences = body.split(/(?<=[.!?])\s+/);
  return [...sources.entries()].map(([ref, url]) => ({
    ref,
    url,
    claims: sentences
      .filter((s) => new RegExp(`\\[\\^?${ref}\\]`).test(s))
      .map((s) => s.trim())
      .slice(0, 10),
  }));
}
