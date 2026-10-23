// M8: `brio login` — the OAuth device flow (RFC 8628). The CLI asks for a code, the signed-in person approves it in the
// browser, and the CLI's session then works as a bearer token: as that person (not an API token), so it may approve.
// Needs Postgres.
import { hasTestDatabase } from "@brio/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";

describe.skipIf(!hasTestDatabase)("M8: brio login (device flow)", () => {
  let h: Harness;
  let person: Client;
  const cli = () => new Client(h);

  beforeAll(async () => {
    h = await startHarness({ runner: false });
    person = new Client(h);
    await person.signIn("device@example.com");
    await person.request("POST", "/v1/workspaces", { name: "Device" });
  });
  afterAll(async () => {
    await h?.close();
  });

  it("refuses unknown clients", async () => {
    const res = await cli().request("POST", "/api/auth/device/code", { client_id: "someone-else" });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("signs the CLI in as the person who approves its code", async () => {
    const start = await cli().request("POST", "/api/auth/device/code", { client_id: "brio-cli" });
    expect(start.statusCode, start.body).toBe(200);
    const { device_code, user_code, verification_uri_complete, interval } = start.json();
    expect(verification_uri_complete).toBe(`http://localhost:3000/device?user_code=${user_code}`);
    expect(interval).toBe(5);

    const poll = () =>
      cli().request("POST", "/api/auth/device/token", {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code,
        client_id: "brio-cli",
      });
    expect((await poll()).json().error).toBe("authorization_pending");

    const seen = await person.request("GET", `/api/auth/device?user_code=${user_code}`);
    expect(seen.json()).toMatchObject({ status: "pending" });
    const ok = await person.request("POST", "/api/auth/device/approve", { userCode: user_code });
    expect(ok.statusCode, ok.body).toBe(200);

    // Polling faster than the interval is refused (slow_down); wait it out.
    let token = "";
    for (let i = 0; i < 10 && !token; i++) {
      const r = await poll();
      if (r.json().access_token) token = r.json().access_token;
      else await new Promise((res) => setTimeout(res, 1000));
    }
    expect(token).not.toBe("");

    const me = cli();
    const ws = await me.request("GET", "/v1/workspaces", undefined, { authorization: `Bearer ${token}` });
    expect(ws.statusCode, ws.body).toBe(200);
    const workspaceId = ws.json().workspaces[0].id;
    // A person, not an API token: it may make tokens (which API tokens may not).
    const made = await me.request(
      "POST",
      "/v1/tokens",
      { name: "from the cli" },
      { authorization: `Bearer ${token}`, "x-brio-workspace": workspaceId },
    );
    expect(made.statusCode, made.body).toBe(201);
    expect(await poll().then((r) => r.json().error)).toBeDefined();
  }, 30_000);
});
