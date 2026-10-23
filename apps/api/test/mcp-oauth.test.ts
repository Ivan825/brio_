// M7: remote MCP clients sign in to Brio with OAuth 2.1 (docs/vendors/protocols.md §2): discovery from the 401
// challenge, protected resource and authorization server metadata, dynamic client registration, authorization code
// with PKCE and the /mcp resource indicator, the person's consent, the token exchange, then MCP calls with the access
// token, acting in the person's workspace. Needs Postgres.
import { createHash, randomBytes } from "node:crypto";
import { hasTestDatabase } from "@brio/db/testing";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_URL, Client, type Harness, startHarness } from "./helpers";

const REDIRECT = "http://127.0.0.1:33418/callback";
const RESOURCE = `${APP_URL}/mcp`;
const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";

describe.skipIf(!hasTestDatabase)("M7: OAuth 2.1 for remote MCP clients", () => {
  let h: Harness;
  let c: Client;
  let base: string;
  let clientId: string;
  let accessToken: string;
  let refreshToken: string;

  beforeAll(async () => {
    h = await startHarness();
    c = new Client(h);
    await c.signIn("oauth@example.com");
    await c.request("POST", "/v1/workspaces", { name: "OAuth" });
    base = await h.server.app.listen({ port: 0, host: "127.0.0.1" });
  });
  afterAll(async () => h?.close());

  it("challenges an unauthenticated client towards the protected resource metadata", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${APP_URL}/.well-known/oauth-protected-resource/mcp", scope="brio"`,
    );
    const prm = (await c.request("GET", "/.well-known/oauth-protected-resource/mcp")).json();
    expect(prm.resource).toBe(RESOURCE);
    expect(prm.authorization_servers).toHaveLength(1);
    const as = (await c.request("GET", "/.well-known/oauth-authorization-server/api/auth")).json();
    expect(as.issuer).toBe(prm.authorization_servers[0]);
    expect(as.code_challenge_methods_supported).toContain("S256");
    expect(as.registration_endpoint).toMatch(/\/api\/auth\/oauth2\/register$/);
    expect(as.client_id_metadata_document_supported).toBe(true);
  });

  it("registers a client, gets the person's consent and issues tokens bound to /mcp", async () => {
    const reg = await c.request("POST", "/api/auth/oauth2/register", {
      client_name: "Claude Code",
      application_type: "native",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect(reg.statusCode, reg.body).toBeLessThan(300);
    clientId = reg.json().client_id;

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: "openid offline_access brio",
      state: "s-123",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: RESOURCE,
    });
    const auth = await c.request("GET", `/api/auth/oauth2/authorize?${q}`);
    expect(auth.statusCode, auth.body).toBe(302);
    const consentUrl = new URL(String(auth.headers.location), APP_URL);
    expect(consentUrl.pathname).toBe("/oauth/consent");

    const consent = await c.request("POST", "/api/auth/oauth2/consent", {
      accept: true,
      oauth_query: consentUrl.search.slice(1),
    });
    expect(consent.statusCode, consent.body).toBe(200);
    const back = new URL(consent.json().url);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("s-123");
    const code = back.searchParams.get("code") ?? "";

    const token = await h.server.app.inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
        resource: RESOURCE,
      }).toString(),
    });
    expect(token.statusCode, token.body).toBe(200);
    accessToken = token.json().access_token;
    refreshToken = token.json().refresh_token;
    expect(accessToken.split(".")).toHaveLength(3);
    const claims = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString());
    expect([claims.aud].flat()).toContain(RESOURCE);
    expect(refreshToken).toBeTruthy();
  });

  it("serves the tools to the signed-in client in the person's workspace", async () => {
    const mcp = new McpClient({ name: "Claude Code", version: "1.0.0" });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
      }),
    );
    expect((await mcp.listTools()).tools.map((t) => t.name)).toContain("delegate");
    expect(textOf(await mcp.callTool({ name: "list_missions", arguments: {} }))).toBe("No missions yet.");
    await mcp.close();
  });

  it("refuses tampered and foreign tokens", async () => {
    const [head, body] = accessToken.split(".");
    const forged = `${head}.${body}.${"A".repeat(43)}`;
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${forged}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });
});
