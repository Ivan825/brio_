import type { NextConfig } from "next";

// Load the repo-root .env in development; deployments set the environment directly.
try {
  process.loadEnvFile(new URL("../../.env", import.meta.url));
} catch {
  // no .env
}

const apiUrl = process.env.API_URL ?? "http://localhost:4000";

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@brio/brand", "@brio/schema"],
  poweredByHeader: false,
  // The browser only ever talks to this origin: auth cookies stay first-party and SSE needs no CORS.
  async rewrites() {
    return [
      { source: "/api/auth/:path*", destination: `${apiUrl}/api/auth/:path*` },
      { source: "/v1/:path*", destination: `${apiUrl}/v1/:path*` },
    ];
  },
};

export default config;
