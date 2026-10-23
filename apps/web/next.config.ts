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
      // Brio's MCP and A2A servers, and the discovery documents (OAuth, Agent Card) clients look for at the root (M7).
      { source: "/mcp", destination: `${apiUrl}/mcp` },
      { source: "/a2a", destination: `${apiUrl}/a2a` },
      { source: "/.well-known/:path*", destination: `${apiUrl}/.well-known/:path*` },
    ];
  },
};

export default config;
