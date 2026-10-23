// API tokens (M7): made by a signed-in person for one workspace, shown once, stored as a hash; a token acts as its person
// in that workspace only, cannot administer workspaces or mint tokens, and stops working when revoked. Needs Postgres.
import { schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";

describe.skipIf(!hasTestDatabase)("API tokens", () => {
  let h: Harness;
  let c: Client;
  let home: string;
  let other: string;
  let token: string;
  let tokenId: string;

  const as = (
    t: string,
    method: string,
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    h.server.app.inject({
      method: method as "GET",
      url,
      headers: { authorization: `Bearer ${t}`, ...headers },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  beforeAll(async () => {
    h = await startHarness();
    c = new Client(h);
    await c.signIn("tokens@example.com");
    other = (await c.request("POST", "/v1/workspaces", { name: "Other" })).json().workspace.id;
    home = (await c.request("POST", "/v1/workspaces", { name: "Home" })).json().workspace.id;
  });
  afterAll(async () => h?.close());

  it("is made once by a signed-in person and stored only as a hash", async () => {
    const res = await c.request("POST", "/v1/tokens", { name: "laptop CLI", expiresInDays: 30 });
    expect(res.statusCode, res.body).toBe(201);
    const t = res.json().token;
    token = t.value;
    tokenId = t.id;
    expect(token).toMatch(/^brio_pat_[0-9A-Za-z]{40}$/);
    expect(t.prefix).toBe(token.slice(0, 13));
    const [row] = await h.db.db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, tokenId));
    expect(row?.workspaceId).toBe(home);
    expect(JSON.stringify(row)).not.toContain(token);
    const listed = (await c.request("GET", "/v1/tokens")).json().tokens;
    expect(listed).toEqual([expect.objectContaining({ id: tokenId, name: "laptop CLI", prefix: t.prefix })]);
    expect(JSON.stringify(listed)).not.toContain(token);
  });

  it("acts as its person in its own workspace only", async () => {
    const list = await as(token, "GET", "/v1/workspaces");
    expect(list.statusCode).toBe(200);
    expect(list.json().workspaces.map((w: { id: string }) => w.id)).toEqual([home]);
    expect((await as(token, "GET", "/v1/agents")).statusCode).toBe(200);
    expect((await as(token, "GET", "/v1/agents", undefined, { "x-brio-workspace": other })).statusCode).toBe(
      403,
    );
    expect((await as(token, "GET", `/v1/workspaces/${other}/members`)).statusCode).toBe(404);
    const m = await as(token, "POST", "/v1/missions", { goal: "Write a haiku" });
    expect(m.statusCode, m.body).toBe(201);
    const [row] = await h.db.db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, tokenId));
    expect(row?.lastUsedAt).not.toBeNull();
  });

  it("cannot administer workspaces or mint tokens", async () => {
    expect((await as(token, "POST", "/v1/workspaces", { name: "Sneaky" })).json().error).toBe(
      "token_not_allowed",
    );
    expect((await as(token, "POST", "/v1/tokens", { name: "more" })).json().error).toBe("token_not_allowed");
    expect((await as(token, "DELETE", `/v1/workspaces/${home}`)).json().error).toBe("token_not_allowed");
    expect((await as(token, "POST", `/v1/workspaces/${other}/activate`)).statusCode).toBe(403);
  });

  it("stops working when revoked, and unknown tokens are refused", async () => {
    expect((await c.request("DELETE", `/v1/tokens/${tokenId}`)).statusCode).toBe(204);
    const r = await as(token, "GET", "/v1/agents");
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe("bad_token");
    expect((await as(`brio_pat_${"x".repeat(40)}`, "GET", "/v1/agents")).statusCode).toBe(401);
  });
});
