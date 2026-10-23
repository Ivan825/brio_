"use client";

import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { passkeyClient } from "@better-auth/passkey/client";
import { magicLinkClient, organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/** Same-origin: /api/auth is proxied to the API by next.config rewrites. */
export const authClient = createAuthClient({
  basePath: "/api/auth",
  // oauthProviderClient: on the consent page, requests carry the signed OAuth query of the authorization in progress.
  plugins: [magicLinkClient(), organizationClient(), passkeyClient(), oauthProviderClient()],
});
