// M9: workspace roles enforced everywhere. Owners and admins administer (connectors, budgets, policies, the ledger,
// people); members act (missions, agents, plans, approvals); viewers only read; outsiders see nothing. Role changes
// follow the rules (only owners make owners and admins; a workspace keeps an owner) and are in the ledger.
// Needs Postgres.
import { schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";
import { ScriptedVendors } from "./vendors";

const OPENAI_KEY = ["sk", "proj", "roles01234567890abcdefghij"].join("-");
type Who = "owner" | "admin" | "member" | "viewer" | "outsider";

const PLAN = {
  tasks: [
    {
      key: "t",
      type: "write.summary",
      title: "T",
      contract: {
        objective: "T",
        inputs: [],
        outputs: [{ kind: "report", description: "t" }],
        acceptance: [{ kind: "diff_scope", hard: true }],
        constraints: [],
        sensitivity: "internal",
      },
      dependsOn: [],
      suggestedMode: "single",
    },
  ],
  assumptions: [],
  questions: [],
};

describe.skipIf(!hasTestDatabase)("M9: roles enforced everywhere", () => {
  let h: Harness;
  let workspaceId: string;
  const as: Record<Who, Client> = {} as Record<Who, Client>;
  const ids: Record<Who, string> = {} as Record<Who, string>;
  let connectorId: string;

  const call = (who: Who, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown) =>
    as[who].request(method, url, body, { "x-brio-workspace": workspaceId });

  beforeAll(async () => {
    h = await startHarness({ runner: false, fetch: new ScriptedVendors(() => ({ text: "ok" })).fetch });
    for (const who of ["owner", "admin", "member", "viewer", "outsider"] as Who[]) {
      as[who] = new Client(h);
      ids[who] = (await as[who].signIn(`${who}-roles@example.com`)).id;
    }
    workspaceId = (await as.owner.request("POST", "/v1/workspaces", { name: "Roles" })).json().workspace.id;
    await as.outsider.request("POST", "/v1/workspaces", { name: "Elsewhere" });
    for (const who of ["admin", "member", "viewer"] as const) {
      const inv = await as.owner.request("POST", `/v1/workspaces/${workspaceId}/invitations`, {
        email: `${who}-roles@example.com`,
        role: who,
      });
      expect(inv.statusCode, inv.body).toBe(201);
      const accept = await as[who].request("POST", "/api/auth/organization/accept-invitation", {
        invitationId: inv.json().invitation.id,
      });
      expect(accept.statusCode, accept.body).toBe(200);
    }
    connectorId = (
      await call("owner", "POST", "/v1/connectors", { registryKey: "openai-api", apiKey: OPENAI_KEY })
    ).json().connector.id;
  });
  afterAll(async () => {
    await h?.close();
  });

  const expectRoles = async (
    allowed: Who[],
    request: (who: Who) => Promise<{ statusCode: number; body: string }>,
  ) => {
    for (const who of ["viewer", "member", "admin", "owner", "outsider"] as Who[]) {
      const res = await request(who);
      if (allowed.includes(who)) expect(res.statusCode, `${who}: ${res.body}`).toBeLessThan(300);
      else expect([403, 404], `${who}: ${res.statusCode} ${res.body}`).toContain(res.statusCode);
    }
  };

  it("everyone in the workspace reads it; an outsider cannot", async () => {
    for (const url of [
      "/v1/missions",
      "/v1/agents",
      "/v1/inbox",
      "/v1/policies",
      "/v1/budgets",
      "/v1/projects",
    ])
      await expectRoles(["viewer", "member", "admin", "owner"], (who) => call(who, "GET", url));
  });

  it("members act: missions, agents, crews, projects; viewers do not", async () => {
    await expectRoles(["member", "admin", "owner"], (who) =>
      call(who, "POST", "/v1/missions", { goal: `by ${who}`, plan: PLAN }),
    );
    await expectRoles(["member", "admin", "owner"], (who) =>
      call(who, "POST", "/v1/agents", {
        connectorId,
        name: `agent of ${who}`,
        model: "gpt-coder",
        priceOverride: { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null },
      }),
    );
    await expectRoles(["member", "admin", "owner"], (who) =>
      call(who, "POST", "/v1/projects", { name: `p-${who}` }),
    );
    await expectRoles(["member", "admin", "owner"], (who) => call(who, "POST", "/v1/tokens", { name: who }));
  });

  it("members approve plans and actions; viewers cannot", async () => {
    const m = (await call("owner", "POST", "/v1/missions", { goal: "Approve me", plan: PLAN })).json().mission
      .id;
    expect((await call("viewer", "POST", `/v1/missions/${m}/plans/1/approve`)).statusCode).toBe(403);
    expect((await call("member", "POST", `/v1/missions/${m}/plans/1/approve`)).statusCode).toBe(200);
    const [a] = await h.db.db
      .insert(schema.approvals)
      .values({
        workspaceId,
        subjectKind: "mission",
        subjectId: m,
        action: "push_branch",
        requestedBy: "brio",
      })
      .returning();
    expect(
      (await call("viewer", "POST", `/v1/approvals/${a!.id}/decide`, { decision: "approve" })).statusCode,
    ).toBe(403);
    expect(
      (await call("member", "POST", `/v1/approvals/${a!.id}/decide`, { decision: "approve" })).statusCode,
    ).toBe(200);
  });

  it("owners and admins administer: connectors, budgets, policies, the ledger, invitations", async () => {
    await expectRoles(["admin", "owner"], (who) =>
      call(who, "PUT", "/v1/budgets", { scopeKind: "workspace", limitUsd: 100 }),
    );
    await expectRoles(["admin", "owner"], (who) =>
      call(who, "POST", "/v1/policies", {
        kind: "connector_allow",
        name: `by ${who}`,
        rule: { deny: ["groq-api"] },
      }),
    );
    await expectRoles(["admin", "owner"], (who) => call(who, "GET", "/v1/ledger"));
    await expectRoles(["admin", "owner"], (who) =>
      call(who, "POST", "/v1/connectors", { registryKey: "openai-api", apiKey: OPENAI_KEY }),
    );
    await expectRoles(["admin", "owner"], (who) =>
      call(who, "POST", `/v1/workspaces/${workspaceId}/invitations`, { email: `new-${who}@example.com` }),
    );
  });

  let memberToken = "";
  const a2a = (token: string) =>
    h.server.app.inject({
      method: "POST",
      url: "/a2a",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "a2a-version": "1.0" },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "GetTask",
        params: { id: "00000000-0000-7000-8000-000000000000" },
      },
    });

  it("lets an A2A client act only for someone who may act in the workspace", async () => {
    const made = await call("member", "POST", "/v1/tokens", { name: "a2a" });
    expect(made.statusCode, made.body).toBe(201);
    memberToken = made.json().token.value;
    const res = await a2a(memberToken);
    expect(res.statusCode, res.body).toBe(200);
  });

  it("changes roles by the rules, and records each change", async () => {
    // Members and viewers change nobody.
    expect(
      (
        await call("member", "PATCH", `/v1/workspaces/${workspaceId}/members/${ids.viewer}`, {
          role: "member",
        })
      ).statusCode,
    ).toBe(403);
    // An admin may move people between member and viewer, not make admins.
    expect(
      (
        await call("admin", "PATCH", `/v1/workspaces/${workspaceId}/members/${ids.viewer}`, {
          role: "member",
        })
      ).statusCode,
    ).toBe(200);
    const promote = await call("admin", "PATCH", `/v1/workspaces/${workspaceId}/members/${ids.viewer}`, {
      role: "admin",
    });
    expect(promote.json().error).toBe("owner_only");
    expect(
      (await call("admin", "DELETE", `/v1/workspaces/${workspaceId}/members/${ids.owner}`)).json().error,
    ).toBe("owner_only");
    // The owner may; but the last owner stays an owner.
    expect(
      (
        await call("owner", "PATCH", `/v1/workspaces/${workspaceId}/members/${ids.viewer}`, {
          role: "viewer",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call("owner", "PATCH", `/v1/workspaces/${workspaceId}/members/${ids.owner}`, { role: "member" })
      ).json().error,
    ).toBe("last_owner");
    // A removed member sees nothing any more.
    expect(
      (await call("owner", "DELETE", `/v1/workspaces/${workspaceId}/members/${ids.member}`)).statusCode,
    ).toBe(204);
    expect((await call("member", "GET", "/v1/missions")).statusCode).toBe(404);
    // Their API token went with them: no more A2A, no more REST.
    expect((await a2a(memberToken)).statusCode).toBe(401);
    expect(
      (
        await h.server.app.inject({
          method: "GET",
          url: "/v1/missions",
          headers: { authorization: `Bearer ${memberToken}` },
        })
      ).statusCode,
    ).toBe(401);
    const [viewer] = await h.db.db
      .select({ role: schema.members.role })
      .from(schema.members)
      .where(and(eq(schema.members.workspaceId, workspaceId), eq(schema.members.userId, ids.viewer)));
    expect(viewer?.role).toBe("viewer");
    const changes = await h.db.db
      .select()
      .from(schema.ledger)
      .where(and(eq(schema.ledger.workspaceId, workspaceId), eq(schema.ledger.kind, "member.changed")))
      .orderBy(asc(schema.ledger.id));
    expect(changes.map((l) => l.payload)).toEqual([
      expect.objectContaining({ userId: ids.viewer, from: "viewer", to: "member" }),
      expect.objectContaining({ userId: ids.viewer, from: "member", to: "viewer" }),
      expect.objectContaining({ userId: ids.member, removed: true, tokensRevoked: 2 }),
    ]);
  });
});
