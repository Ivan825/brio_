// Brio Tailwind preset. In apps/web/tailwind.config.ts:
//   import brio from "@brio/brand/tailwind.preset";  export default { presets: [brio], content: [...] }
// All colours read CSS variables from tokens.css, so dark (default) and light switch automatically.
import type { Config } from "tailwindcss";

const v = (name: string) => `var(--${name})`;

const preset: Partial<Config> = {
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        brio: { ink: v("brio-ink"), navy: v("brio-navy"), ivory: v("brio-ivory"), brass: v("brio-brass"), "brass-deep": v("brio-brass-deep") },
        bg: v("bg"),
        surface: { DEFAULT: v("surface"), 2: v("surface-2") },
        line: { DEFAULT: v("line"), strong: v("line-strong") },
        fg: { DEFAULT: v("text"), muted: v("text-muted"), subtle: v("text-subtle") },
        primary: { DEFAULT: v("primary"), hover: v("primary-hover"), fg: v("on-primary") },
        accent: { DEFAULT: v("accent"), soft: v("accent-soft") },
        focus: v("focus"),
        agent: { 1: v("agent-1"), 2: v("agent-2"), 3: v("agent-3"), 4: v("agent-4"), 5: v("agent-5"), 6: v("agent-6") },
        success: v("success"), warning: v("warning"), danger: v("danger"), info: v("info"), running: v("running"),
      },
      fontFamily: { sans: [v("font-sans")], mono: [v("font-mono")] },
      fontSize: {
        "2xs": ["11px", "16px"], xs: ["12px", "16px"], sm: ["13px", "20px"], base: ["14px", "22px"], md: ["16px", "24px"],
        lg: ["20px", "28px"], xl: ["24px", "32px"], "2xl": ["32px", "38px"], "3xl": ["48px", "52px"], "4xl": ["64px", "68px"],
      },
      borderRadius: { xs: "4px", sm: "6px", md: "8px", lg: "12px", icon: "28px" },
      boxShadow: { pop: v("shadow-pop"), brass: v("glow-brass") },
      transitionTimingFunction: { brio: v("ease") },
      transitionDuration: { fast: "120ms", base: "180ms", slow: "300ms" },
      keyframes: { blink: { "0%, 50%": { opacity: "1" }, "50.01%, 100%": { opacity: "0" } } },
      animation: { blink: "blink 1.06s steps(1) infinite" },
    },
  },
};
export default preset;
