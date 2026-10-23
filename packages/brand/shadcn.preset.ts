// Tailwind colour names that shadcn/ui components expect, pointed at Brio tokens via shadcn.css.
// Use alongside tailwind.preset.ts: presets: [brio, brioShadcn].
import type { Config } from "tailwindcss";

const v = (name: string) => `var(--${name})`;

const preset: Partial<Config> = {
  theme: {
    extend: {
      colors: {
        background: v("background"),
        foreground: v("foreground"),
        card: { DEFAULT: v("card"), foreground: v("card-foreground") },
        popover: { DEFAULT: v("popover"), foreground: v("popover-foreground") },
        secondary: { DEFAULT: v("secondary"), foreground: v("secondary-foreground") },
        muted: { DEFAULT: v("muted"), foreground: v("muted-foreground") },
        destructive: { DEFAULT: v("destructive"), foreground: v("destructive-foreground") },
        border: v("border"),
        input: v("input"),
        ring: v("ring"),
      },
    },
  },
};
export default preset;
