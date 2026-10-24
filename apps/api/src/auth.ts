import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { passkey } from "@better-auth/passkey";
import { type Db, schema } from "@brio/db";
import type { Ledger } from "@brio/governance";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { bearer, deviceAuthorization, jwt, magicLink, organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, memberAc, ownerAc } from "better-auth/plugins/organization/access";
import { uuidv7 } from "uuidv7";
import type { Config } from "./config";
import type { Mailer } from "./mailer";
import { SignupPolicy } from "./signup";

export interface AuthDeps {
  db: Db;
  config: Config;
  mailer: Mailer;
  ledger: Ledger;
}

/** Workspace roles for Better Auth's organisation plugin: its defaults, plus viewers, who administer nothing. */
const ACCESS = createAccessControl(defaultStatements);
const ROLES = {
  owner: ACCESS.newRole({ ...ownerAc.statements }),
  admin: ACCESS.newRole({ ...adminAc.statements }),
  member: ACCESS.newRole({ ...memberAc.statements }),
  viewer: ACCESS.newRole({ organization: [] }),
};

/** The device-flow client id of the `brio` CLI. */
export const CLI_CLIENT_ID = "brio-cli";

/** The scope an MCP client asks for to act as its person in Brio (missions, agents' questions, reports). */
export const MCP_SCOPE = "brio";

/**
 * The scope that lets an MCP client decide approvals as its person (M9): asked for explicitly, granted on the consent
 * page, never a default. API tokens never carry it.
 */
export const APPROVE_SCOPE = "brio:approve";

/** Brio's MCP endpoint, the audience OAuth access tokens are bound to (RFC 8707). */
export const mcpResource = (appUrl: string) => `${appUrl.replace(/\/+$/, "")}/mcp`;

/**
 * Better Auth: Google, email magic link, passkeys and organisations (= Brio workspaces); and (M7) the OAuth 2.1
 * authorization server remote MCP clients sign in with — JWT access tokens bound to /mcp, PKCE, consent, Client ID
 * Metadata Documents, and dynamic registration (Cursor documents only that).
 */
export function createAuth({ db, config, mailer, ledger }: AuthDeps) {
  const appUrl = new URL(config.APP_URL);
  const signup = new SignupPolicy(db, config.BRIO_SIGNUP_ALLOW);
  const closed = () =>
    new APIError("FORBIDDEN", {
      message: "Sign-up on this Brio is by invitation. Ask its owner to invite you.",
    });
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
        deviceCode: schema.deviceCodes,
      },
    }),
    advanced: {
      database: { generateId: () => uuidv7() },
      useSecureCookies: appUrl.protocol === "https:",
    },
    socialProviders: config.google ? { google: config.google } : {},
    // D-107: every way an account is made (magic link, Google, passkey) passes here.
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!(await signup.maySignUp(user.email))) throw closed();
          },
        },
      },
    },
    plugins: [
      magicLink({
        expiresIn: 15 * 60,
        sendMagicLink: async ({ email, url }) => {
          if (!(await signup.maySignIn(email))) throw closed();
          await mailer.send({ to: email, subject: "Sign in to Brio", text: `Sign in: ${url}`, link: url });
        },
      }),
      passkey({ rpID: appUrl.hostname, rpName: "Brio", origin: config.APP_URL }),
      // JWTs are for MCP clients (OAuth); signing one into a header on every session lookup only cost a key read and
      // a signature per request.
      jwt({ disableSettingJwtHeader: true }),
      mcp({
        loginPage: "/sign-in",
        consentPage: "/oauth/consent",
        resource: mcpResource(config.APP_URL),
        scopes: ["openid", "profile", "email", "offline_access", MCP_SCOPE, APPROVE_SCOPE],
        clientRegistrationDefaultScopes: ["openid", "profile", "email", "offline_access", MCP_SCOPE],
        // A client may step up to brio:approve when it asks a person to sign in; only their consent grants it (M9).
        clientRegistrationAllowedScopes: [APPROVE_SCOPE],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
      // `brio login` (M8): the device flow (RFC 8628) — a code in the terminal, approved by the signed-in person at
      // /device; the CLI then holds a session of its own and sends it as a bearer token.
      deviceAuthorization({
        verificationUri: `${config.APP_URL.replace(/\/+$/, "")}/device`,
        expiresIn: "10m",
        interval: "5s",
        validateClient: (clientId) => clientId === CLI_CLIENT_ID,
      }),
      bearer(),
      organization({
        creatorRole: "owner",
        // Brio's roles (M9): owners and admins administer; members act (missions, agents, approvals); viewers only
        // read. What each may do in Brio itself is enforced by every route (requireMember).
        ac: ACCESS,
        roles: ROLES,
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
