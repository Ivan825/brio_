import { BRAND, THEME_COLOR } from "@brio/brand";
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: BRAND.name,
    short_name: BRAND.name,
    description: BRAND.description,
    start_url: "/missions",
    display: "standalone",
    background_color: THEME_COLOR.dark,
    theme_color: THEME_COLOR.dark,
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/brand/favicon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
