// The site's pages and the sections inside them. Links on the site point only at these (checked by test), and each
// page's sections are listed here so an anchor link can be checked too.
import { DOCS, docHref } from "./docs-index";

export const PAGES = {
  home: {
    path: "/",
    file: "app/page.tsx",
    title: "Home",
    sections: [
      "problem",
      "what",
      "how",
      "ways",
      "modes",
      "agents",
      "verify",
      "learn",
      "safety",
      "see",
      "ways-in",
      "start",
      "faq",
    ],
  },
  how: {
    path: "/how-it-works",
    file: "app/how-it-works/page.tsx",
    title: "How it works",
    sections: [
      "lifecycle",
      "plan",
      "route",
      "modes",
      "coordinate",
      "run",
      "verify",
      "learn",
      "deliver",
      "events",
      "chat",
    ],
  },
  features: {
    path: "/features",
    file: "app/features/page.tsx",
    title: "Features",
    sections: [
      "chat",
      "missions",
      "board",
      "inbox",
      "scoreboard",
      "crews",
      "memory",
      "governance",
      "connectors",
      "ways-in",
      "local-runner",
      "teams",
      "operate",
    ],
  },
  security: {
    path: "/security",
    file: "app/security/page.tsx",
    title: "Security",
    sections: [
      "official",
      "where",
      "vault",
      "sandbox",
      "local",
      "policies",
      "budgets",
      "approvals",
      "roles",
      "injection",
      "ledger",
      "accounts",
      "review",
    ],
  },
  docs: { path: "/docs", file: "app/docs/page.tsx", title: "Docs", sections: [] },
} as const;

export type PageKey = keyof typeof PAGES;

/** The header's links, in order. */
export const NAV = [
  { href: PAGES.how.path, label: "How it works" },
  { href: PAGES.features.path, label: "Features" },
  { href: PAGES.security.path, label: "Security" },
  { href: PAGES.docs.path, label: "Docs" },
] as const;

/** Every path the site serves, with the anchors on it (docs anchors come from their headings, checked separately). */
export function sitePaths(): Map<string, readonly string[]> {
  const paths = new Map<string, readonly string[]>();
  for (const p of Object.values(PAGES)) paths.set(p.path, p.sections);
  for (const d of DOCS) paths.set(docHref(d.slug), []);
  return paths;
}

/** A section of a page, as a link. */
export const at = <K extends PageKey>(page: K, section: (typeof PAGES)[K]["sections"][number]) =>
  `${PAGES[page].path}#${section}`;
