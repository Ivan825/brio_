import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@brio/brand"],
  poweredByHeader: false,
};

export default config;
