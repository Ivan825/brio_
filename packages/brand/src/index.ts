// Brand strings and token helpers. Colours are referenced by CSS variable only; the values live in tokens.css.

export const BRAND = {
  name: "Brio",
  wordmark: "brio",
  tagline: "Every AI, one ensemble.",
  description:
    "Brio plans one goal into tasks, routes each to the best agent across vendors, coordinates them, verifies the results and learns who wins.",
} as const;

/**
 * Page background per theme, for places that need a literal colour string rather than a CSS variable
 * (Next.js viewport themeColor, the PWA manifest). Kept equal to --bg in tokens.css by test.
 */
export const THEME_COLOR = { dark: "#0B0D17", light: "#F7F7FA" } as const;

/** Agent lane colours, in assignment order (brand/BRAND.md §2). Never use for status. */
export const AGENT_COLOR_COUNT = 6;

export function agentColorVar(index: number): string {
  if (!Number.isInteger(index) || index < 0)
    throw new RangeError(`agent index must be a non-negative integer, got ${index}`);
  return `var(--agent-${(index % AGENT_COLOR_COUNT) + 1})`;
}

export const STATUS_COLOR_VARS = {
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--danger)",
  info: "var(--info)",
  running: "var(--running)",
} as const;

export type BrandStatus = keyof typeof STATUS_COLOR_VARS;

/** Logo files shipped in packages/brand/logo and mirrored into apps/web/public/brand. */
export const LOGO_FILES = [
  "brio-icon-light.svg",
  "brio-icon.svg",
  "brio-wordmark-dark-animated.svg",
  "brio-wordmark-dark.png",
  "brio-wordmark-dark.svg",
  "brio-wordmark-light-animated.svg",
  "brio-wordmark-light.png",
  "brio-wordmark-light.svg",
  "brio-wordmark-mono.svg",
  "favicon.svg",
  "icon-16.png",
  "icon-180.png",
  "icon-192.png",
  "icon-32.png",
  "icon-512.png",
  "og-card.png",
  "og-card.svg",
] as const;

export type LogoFile = (typeof LOGO_FILES)[number];
