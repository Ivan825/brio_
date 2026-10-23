"use client";

import { passkeyClient } from "@better-auth/passkey/client";
import { magicLinkClient, organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/** Same-origin: /api/auth is proxied to the API by next.config rewrites. */
export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [magicLinkClient(), organizationClient(), passkeyClient()],
});
