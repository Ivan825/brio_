# Brio brand

Terminal-native, dark-first, one accent. Brio should feel like a sharp developer tool (in the family of Relay's `./relay`, Vercel, Linear), not a corporate SaaS.

## 1. Logo

**`brio_`** — the name in bold monospace followed by a brass cursor.

The cursor is the idea: Brio is always ready for the next instruction, and while agents are working it blinks. When a mission finishes, it goes solid.

| File (`brand/logo/`) | Use |
|---|---|
| `brio-wordmark-dark.svg` / `.png` | Default. Ivory wordmark, brass cursor, on dark backgrounds |
| `brio-wordmark-light.svg` / `.png` | Ink wordmark, deep-brass cursor, on light backgrounds |
| `brio-wordmark-dark-animated.svg`, `brio-wordmark-light-animated.svg` | Blinking cursor (SVG SMIL). Landing page hero, loading screens |
| `brio-wordmark-mono.svg` | Single colour (`currentColor`) for one-colour contexts |
| `brio-icon.svg`, `brio-icon-light.svg` | App icon / avatar: `b_` on a navy (or white) rounded tile |
| `favicon.svg`, `icon-16.png`, `icon-32.png` | Browser tab |
| `icon-180.png` (Apple touch), `icon-192.png`, `icon-512.png` (PWA manifest) | Home-screen icons |
| `og-card.svg` / `.png` (1200×630) | Social share image |

The letterforms are outlined paths (set in Geist Mono Bold, OFL licence), so no font is needed to display the logo.

Rules
- Always lowercase. Never write "BRIO" or "Brio_" in the logo. In running text the product name is **Brio** (capital B, no underscore).
- The cursor is always brass (`--brio-brass` on dark, `--brio-brass-deep` on light). Never recolour it to an agent colour.
- Clear space: at least the width of one character (the cursor's width) on every side.
- Minimum size: wordmark 64 px wide; below that, use the `b_` icon.
- Don't add gradients, shadows, outlines, or rotate/stretch it.

In the UI, render the wordmark as live text when convenient: `<span class="font-mono font-bold">brio</span><span class="brio-cursor"></span>`.

## 2. Colour

Dark is the default look; light mode is fully supported. All values live in `brand/tokens.css`.

| Role | Dark | Light | Notes |
|---|---|---|---|
| Background | `#0B0D17` | `#F7F7FA` | Near-black with an indigo bias |
| Surface | `#121527` | `#FFFFFF` | Panels, cards, icon tile |
| Surface 2 | `#181C33` | `#F0F1F6` | Hover, nested panels |
| Line | `#262B4A` | `#E1E3EC` | Hairline borders do most of the structure |
| Text | `#EDEFF7` | `#0B0D17` | |
| Text muted | `#9EA3BF` | `#555A75` | |
| **Brass (accent)** | `#F2B33D` | `#C98A12` | The cursor. Primary buttons on dark, running state, key highlights. Use sparingly |
| Focus | `#6C8CFF` | `#4F6FF0` | Focus rings, links |

**Agent palette** (one colour per agent lane on the board, agent chips, charts; never for status), in assignment order:
teal `#2BB3A8` · coral `#F2674F` · sky `#6C8CFF` · green `#5CBF6E` · violet `#A88BFA` · sand `#E8C36A` (light-mode variants in tokens.css).

**Status**: success `#4CC38A`, warning `#FB923C`, danger `#F87171`, info `#6C8CFF`, running = brass (blinking cursor).

## 3. Type

- **Geist Sans** for UI and prose. **Geist Mono** for the logo, headings on marketing pages, labels, IDs, costs, timestamps, code, status lines and the board's event stream.
- Install via the `geist` npm package (`geist/font/sans`, `geist/font/mono` with next/font), which exposes `--font-geist-sans` and `--font-geist-mono`; tokens.css falls back to Inter / JetBrains Mono.
- Scale (px): 11, 12, 13, **14 (UI base)**, 16, 20, 24, 32, 48, 64. Use `tabular-nums` for all numbers in tables and the board.
- Section labels: Geist Mono, 11–12 px, uppercase, letter-spacing 0.08em, muted colour.

## 4. UI style

- **Structure with borders, not shadows.** 1 px `--line` borders; shadows only for popovers and menus.
- **Radius:** 6–8 px for controls and cards, 12 px for large panels, 28 px only for the app icon.
- **Density:** developer-tool density. 14 px base, compact tables, keyboard shortcuts everywhere (⌘K command palette).
- **Monospace for machine data:** anything an agent or the system produced (IDs, file paths, commands, costs, event lines) is mono; anything a person reads as prose is sans.
- **Terminal touches, used with restraint:** `$` prompts in empty states, the blinking cursor for "running", `~/project` style breadcrumbs, `→` for handoffs. Never fake a full terminal UI where a normal control is clearer.
- **The live board** is the hero screen: lanes per agent in agent colours, task cards with mono IDs, a thin brass progress line for running tasks, verdict chips (pass / revise / fail) in status colours.
- **Motion:** 120–300 ms, `cubic-bezier(0.2, 0.8, 0.2, 1)`. The only looping animation is the cursor blink. Respect `prefers-reduced-motion`.

## 5. Voice

Short, direct, technical, a little warm. Talk like a senior engineer, not a marketer.
- Buttons say exactly what happens: "Run mission", "Approve plan", "Open PR".
- Status lines read like logs: `codex → task 3 · tests passed · $0.31 · 2m14s`.
- Tagline options: **"Every AI, one ensemble."** · "Conduct every agent." · "One goal. Every AI."

## 6. Files Claude Code should use

- `brand/tokens.css` → copy into `packages/brand/tokens.css`, import in `apps/web/app/globals.css`.
- `brand/tailwind.preset.ts` → `packages/brand/tailwind.preset.ts`, used as a preset in `apps/web/tailwind.config.ts`.
- `brand/logo/*` → `packages/brand/logo/` and `apps/web/public/` (favicon, icons, og-card, wordmarks). Set the Next.js metadata icons and Open Graph image from these.
- Map shadcn/ui CSS variables to these tokens (`--background` → `--bg`, `--primary` → `--primary`, `--ring` → `--focus`, `--border` → `--line`, etc.) rather than using shadcn's default palette.
