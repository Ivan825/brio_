import { createHash, randomBytes } from "node:crypto";
import { createWorkspace, expect, lastMail, signIn, test, uniqueEmail } from "./fixtures";

const REDIRECT = "http://127.0.0.1:33418/callback";

test("an MCP client signs in with OAuth: sign in, consent, code back to the client, token for /mcp", async ({
  page,
  request,
  baseURL,
}) => {
  const email = uniqueEmail("oauth");
  // A person with a workspace (the client will act in it).
  await signIn(page, email);
  await createWorkspace(page, "Agents");
  await page.context().clearCookies();

  // The client registers (dynamic registration, as Cursor does) and sends the person to authorize, signed out.
  const reg = await request.post("/api/auth/oauth2/register", {
    data: {
      client_name: "Test MCP client",
      application_type: "native",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
  });
  expect(reg.ok()).toBe(true);
  const clientId = (await reg.json()).client_id as string;
  const verifier = randomBytes(32).toString("base64url");
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "openid offline_access brio",
    state: "e2e-state",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: `${baseURL}/mcp`,
  });
  // The client's loopback callback: capture the code instead of leaving the browser.
  let callback: URL | null = null;
  await page.route(`${REDIRECT}**`, async (route) => {
    callback = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: "text/html", body: "<p>You can close this window.</p>" });
  });

  await page.goto(`/api/auth/oauth2/authorize?${q}`);
  await expect(page).toHaveURL(/\/sign-in\?/);
  const first = (await lastMail(email)).link;
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  let link = first;
  for (let i = 0; i < 50 && link === first; i++) {
    link = (await lastMail(email)).link;
    if (link === first) await new Promise((r) => setTimeout(r, 100));
  }
  // The emailed link carries on with the authorization after sign-in.
  expect(decodeURIComponent(link)).toContain("/oauth/continue?");
  await page.goto(new URL(link).pathname + new URL(link).search);

  await expect(page).toHaveURL(/\/oauth\/consent\?/);
  await expect(page.getByRole("heading", { name: "An agent wants to use Brio as you" })).toBeVisible();
  await expect(page.getByText("Start missions, read their reports")).toBeVisible();
  await page.getByRole("button", { name: "Allow" }).click();
  await expect.poll(() => callback?.searchParams.get("state")).toBe("e2e-state");
  const code = (callback as URL | null)?.searchParams.get("code") ?? "";

  const token = await request.post("/api/auth/oauth2/token", {
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${baseURL}/mcp`,
    },
  });
  expect(token.ok(), await token.text()).toBe(true);
  const accessToken = (await token.json()).access_token as string;

  // Through the web origin, as a remote client reaches Brio.
  const res = await request.post("/mcp", {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_missions", arguments: {} } },
  });
  expect(res.ok(), await res.text()).toBe(true);
  expect(JSON.stringify(await res.json())).toContain("No missions yet.");
  const prm = await request.get("/.well-known/oauth-protected-resource/mcp");
  expect((await prm.json()).resource).toBe(`${baseURL}/mcp`);
});
