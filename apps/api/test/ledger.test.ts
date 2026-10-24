// M9: the audit ledger for people — read newest first, verified end to end, exported for auditors; and a tampered
// entry is found by the verification at the exact place. Owners and admins only. Needs Postgres.
import { schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";

describe.skipIf(!hasTestDatabase)("M9: the audit ledger", () => {
  let h: Harness;
  let c: Client;
  let workspaceId: string;

  beforeAll(async () => {
    h = await startHarness({ runner: false });
    c = new Client(h);
    await c.signIn("audit@example.com");
    workspaceId = (await c.request("POST", "/v1/workspaces", { name: "Audit" })).json().workspace.id;
    await c.request("POST", "/v1/tokens", { name: "ci" });
    await c.request("PUT", "/v1/budgets", { scopeKind: "workspace", limitUsd: 50 });
    await c.request("POST", "/v1/policies", {
      kind: "connector_allow",
      name: "No Groq",
      rule: { deny: ["groq-api"] },
    });
  });
  afterAll(async () => {
    await h?.close();
  });

  it("lists entries newest first, and verifies the whole chain", async () => {
    const page = (await c.request("GET", "/v1/ledger?limit=2")).json();
    expect(page.entries.map((e: { kind: string }) => e.kind)).toEqual(["policy.change", "policy.change"]);
    expect(page.next).toBe(page.entries[1].seq);
    const rest = (await c.request("GET", `/v1/ledger?before=${page.next}`)).json();
    expect(rest.entries.map((e: { kind: string }) => e.kind)).toEqual(["key.added", "workspace.created"]);
    const verify = (await c.request("GET", "/v1/ledger/verify")).json();
    expect(verify).toMatchObject({ ok: true, length: 4 });
    expect(verify.head).toBe(page.entries[0].hash);
  });

  it("exports JSON Lines and CSV for auditors", async () => {
    const jsonl = await c.request("GET", "/v1/ledger/export?format=jsonl");
    expect(jsonl.headers["content-disposition"]).toMatch(
      /attachment; filename="brio-ledger-\d{4}-\d{2}-\d{2}\.jsonl"/,
    );
    const lines = jsonl.body
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3, 4]);
    expect(lines[0]).toMatchObject({ kind: "workspace.created", prevHash: "0".repeat(64) });
    const csv = await c.request("GET", "/v1/ledger/export?format=csv");
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\n")[0]).toBe("seq,created_at,kind,payload,prev_hash,hash");
    expect(csv.body.trim().split("\n")).toHaveLength(5);
  });

  it("finds a tampered entry exactly where it is", async () => {
    // Only possible by going around the append-only trigger, as an attacker with database access would.
    await h.db.db.execute(sql`alter table ledger disable trigger ledger_append_only`);
    await h.db.db.execute(
      sql`update ledger set payload = jsonb_set(payload, '{limitUsd}', '5000') where workspace_id = ${workspaceId} and seq = 3`,
    );
    await h.db.db.execute(sql`alter table ledger enable trigger ledger_append_only`);
    expect((await c.request("GET", "/v1/ledger/verify")).json()).toMatchObject({
      ok: false,
      brokenAt: 3,
      reason: "hash mismatch",
    });
  });

  it("is for owners and admins", async () => {
    const other = new Client(h);
    await other.signIn("member-audit@example.com");
    const inv = await c.request("POST", `/v1/workspaces/${workspaceId}/invitations`, {
      email: "member-audit@example.com",
      role: "member",
    });
    expect(inv.statusCode, inv.body).toBeLessThan(300);
    const [row] = await h.db.db
      .select()
      .from(schema.invitations)
      .where(eq(schema.invitations.workspaceId, workspaceId));
    const join = await other.request("POST", "/api/auth/organization/accept-invitation", {
      invitationId: row!.id,
    });
    expect(join.statusCode, join.body).toBeLessThan(300);
    const res = await other.request("GET", "/v1/ledger", undefined, { "x-brio-workspace": workspaceId });
    expect(res.statusCode).toBe(403);
  });
});
