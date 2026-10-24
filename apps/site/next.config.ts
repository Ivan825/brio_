import type { NextConfig } from "next";

// A static site (out/): no server, so it can go on any static host — Vercel's free *.vercel.app address needs no domain.
const config: NextConfig = {
  output: "export",
  reactStrictMode: true,
  poweredByHeader: false,
  images: { unoptimized: true },
  transpilePackages: ["@brio/brand"],
};

export default config;
