import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { passkey } from "@better-auth/passkey";
import { type Db, schema } from "@brio/db";
import type { Ledger } from "@brio/governance";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt, magicLink, organization } from "better-auth/plugins";
import { uuidv7 } from "uuidv7";
import type { Config } from "./config";
import type { Mailer } from "./mailer";

export interface AuthDeps {
  db: Db;
  config: Config;
  mailer: Mailer;
  ledger: Ledger;
}

/** The scope an MCP client asks for to act as its person in Brio (missions, agents' questions, reports). */
export const MCP_SCOPE = "brio";

/** Brio's MCP endpoint, the audience OAuth access tokens are bound to (RFC 8707). */
export const mcpResource = (appUrl: string) => `${appUrl.replace(/\/+$/, "")}/mcp`;

/**
 * Better Auth: Google, email magic link, passkeys and organisations (= Brio workspaces); and (M7) the OAuth 2.1
 * authorization server remote MCP clients sign in with — JWT access tokens bound to /mcp, PKCE, consent, Client ID
 * Metadata Documents, and dynamic registration (Cursor documents only that).
 */
export function createAuth({ db, config, mailer, ledger }: AuthDeps) {
  const appUrl = new URL(config.APP_URL);
  return betterAuth({
    appName: "Brio",
    baseURL: config.APP_URL,
    basePath: "/api/auth",
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.APP_URL],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
        passkey: schema.passkeys,
        organization: schema.workspaces,
        member: schema.members,
        invitation: schema.invitations,
        jwks: schema.jwks,
        oauthClient: schema.oauthClients,
        oauthResource: schema.oauthResources,
        oauthClientResource: schema.oauthClientResources,
        oauthRefreshToken: schema.oauthRefreshTokens,
        oauthAccessToken: schema.oauthAccessTokens,
        oauthConsent: schema.oauthConsents,
        oauthClientAssertion: schema.oauthClientAssertions,
      },
    }),
    advanced: {
      database: { generateId: () => uuidv7() },
      useSecureCookies: appUrl.protocol === "https:",
    },
    socialProviders: config.google ? { google: config.google } : {},
    plugins: [
      magicLink({
        expiresIn: 15 * 60,
        sendMagicLink: async ({ email, url }) => {
          await mailer.send({ to: email, subject: "Sign in to Brio", text: `Sign in: ${url}`, link: url });
        },
      }),
      passkey({ rpID: appUrl.hostname, rpName: "Brio", origin: config.APP_URL }),
      jwt(),
      mcp({
        loginPage: "/sign-in",
        consentPage: "/oauth/consent",
        resource: mcpResource(config.APP_URL),
        scopes: ["openid", "profile", "email", "offline_access", MCP_SCOPE],
        clientRegistrationDefaultScopes: ["openid", "profile", "email", "offline_access", MCP_SCOPE],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
      organization({
        creatorRole: "owner",
        invitationExpiresIn: 7 * 24 * 60 * 60,
        schema: {
          session: { fields: { activeOrganizationId: "activeWorkspaceId" } },
          member: { fields: { organizationId: "workspaceId" } },
          invitation: { fields: { organizationId: "workspaceId" } },
        },
        sendInvitationEmail: async ({ id, email, organization: ws, inviter, role }) => {
          const link = `${config.APP_URL}/invite/${id}`;
          await mailer.send({
            to: email,
            subject: `${inviter.user.name || inviter.user.email} invited you to ${ws.name} on Brio`,
            text: `Join ${ws.name} as ${role}: ${link}`,
            link,
          });
          await ledger.append(db, {
            workspaceId: ws.id,
            kind: "member.invited",
            payload: { invitationId: id, email, role, by: inviter.userId },
          });
        },
        organizationHooks: {
          afterCreateOrganization: async ({ organization: ws, user }) => {
            await ledger.append(db, {
              workspaceId: ws.id,
              kind: "workspace.created",
              payload: { name: ws.name, slug: ws.slug, by: user.id },
            });
          },
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
