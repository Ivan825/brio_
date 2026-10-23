import brioShadcn from "@brio/brand/shadcn.preset";
import brio from "@brio/brand/tailwind.preset";
import type { Config } from "tailwindcss";

// Colours come only from the Brio presets: the default Tailwind palette is removed (CLAUDE.md rule 10).
const config: Config = {
  presets: [brio, brioShadcn],
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    colors: { transparent: "transparent", current: "currentColor", inherit: "inherit" },
  },
};

export default config;
