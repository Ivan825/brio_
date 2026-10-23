import { randomBytes } from "node:crypto";
import { readEventsSince, schema } from "@brio/db";
import { hasTestDatabase } from "@brio/db/testing";
import { LocalKeyProvider, Vault } from "@brio/vault";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";

describe.skipIf(!hasTestDatabase)("API (M0 acceptance)", () => {
  let h: Harness;
  let alice: Client;
  let bob: Client;
  let acmeId: string;

  beforeAll(async () => {
    h = await startHarness();
    alice = new Client(h);
    bob = new Client(h);
  });
  afterAll(async () => h?.close());

  it("reports health", async () => {
    const res = await h.server.app.inject({ method: "GET", url: "/health" });
    expect(res.json()).toEqual({ ok: true, db: "up" });
  });

  it("lists sign-in providers (Google only when configured)", async () => {
    const res = await h.server.app.inject({ method: "GET", url: "/v1/auth/providers" });
    expect(res.json()).toEqual({ magicLink: true, passkey: true, google: false });
  });

  it("rejects unauthenticated requests", async () => {
    expect((await new Client(h).request("GET", "/v1/workspaces")).statusCode).toBe(401);
  });

  it("signs in with a magic link", async () => {
    const user = await alice.signIn("alice@example.com");
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("creates a workspace, makes the creator owner and records it on the ledger", async () => {
    const res = await alice.request("POST", "/v1/workspaces", { name: "Acme Labs" });
    expect(res.statusCode, res.body).toBe(201);
    acmeId = res.json().workspace.id;
    expect(res.json().workspace.slug).toMatch(/^acme-labs-[0-9a-f]{6}$/);

    const list = (await alice.request("GET", "/v1/workspaces")).json();
    expect(list.workspaces).toEqual([expect.objectContaining({ id: acmeId, role: "owner", active: true })]);
    const entries = await h.server.ctx.ledger.entries(h.db.db, acmeId);
    expect(entries.map((e) => e.kind)).toEqual(["workspace.created"]);
  });

  it("validates input", async () => {
    const res = await alice.request("POST", "/v1/workspaces", { name: "" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("invites a member (email logged locally) who then joins", async () => {
    const res = await alice.request("POST", `/v1/workspaces/${acmeId}/invitations`, {
      email: "bob@example.com",
    });
    expect(res.statusCode, res.body).toBe(201);
    const invitationId = res.json().invitation.id;

    const mail = (
      await h.server.app.inject({ method: "GET", url: "/v1/dev/outbox?email=bob@example.com" })
    ).json().messages;
    expect(mail).toHaveLength(1);
    expect(mail[0].link).toBe(`http://localhost:3000/invite/${invitationId}`);
    expect(h.logs.join("")).toContain("bob@example.com");

    await bob.signIn("bob@example.com");
    const accept = await bob.request("POST", "/api/auth/organization/accept-invitation", { invitationId });
    expect(accept.statusCode, accept.body).toBe(200);

    const members = (await alice.request("GET", `/v1/workspaces/${acmeId}/members`)).json();
    expect(members.members.map((m: { email: string; role: string }) => [m.email, m.role])).toEqual([
      ["alice@example.com", "owner"],
      ["bob@example.com", "member"],
    ]);
    expect(members.invitations).toEqual([]);
    const kinds = (await h.server.ctx.ledger.entries(h.db.db, acmeId)).map((e) => e.kind);
    expect(kinds).toEqual(["workspace.created", "member.invited"]);
    expect(await h.server.ctx.ledger.verify(h.db.db, acmeId)).toMatchObject({ ok: true });
  });

  it("only owners and admins can invite or rename", async () => {
    await bob.request("POST", `/v1/workspaces/${acmeId}/activate`);
    expect(
      (await bob.request("POST", `/v1/workspaces/${acmeId}/invitations`, { email: "eve@example.com" }))
        .statusCode,
    ).toBe(403);
    expect((await bob.request("PATCH", `/v1/workspaces/${acmeId}`, { name: "Bob's" })).statusCode).toBe(403);
    expect(
      (await alice.request("PATCH", `/v1/workspaces/${acmeId}`, { name: "Acme" })).json().workspace.name,
    ).toBe("Acme");
  });

  it("switches workspace", async () => {
    const beta = (await alice.request("POST", "/v1/workspaces", { name: "Beta" })).json().workspace;
    let list = (await alice.request("GET", "/v1/workspaces")).json();
    expect(list.activeWorkspaceId).toBe(beta.id);
    const res = await alice.request("POST", `/v1/workspaces/${acmeId}/activate`);
    expect(res.statusCode, res.body).toBe(200);
    list = (await alice.request("GET", "/v1/workspaces")).json();
    expect(list.activeWorkspaceId).toBe(acmeId);
    expect(list.workspaces.map((w: { name: string; active: boolean }) => [w.name, w.active])).toEqual([
      ["Acme", true],
      ["Beta", false],
    ]);
  });

  it("hides workspaces from non-members", async () => {
    const eve = new Client(h);
    await eve.signIn("eve@example.com");
    expect((await eve.request("POST", `/v1/workspaces/${acmeId}/activate`)).statusCode).toBe(404);
    expect((await eve.request("GET", `/v1/workspaces/${acmeId}/members`)).statusCode).toBe(404);
  });

  it("POST /v1/missions writes events and starts planning; with no agents it waits and says why", async () => {
    const res = await alice.request("POST", "/v1/missions", { goal: "Add passkey sign-in to the web app" });
    expect(res.statusCode, res.body).toBe(201);
    const m = res.json().mission;
    expect(m).toMatchObject({ status: "planning", workspaceId: acmeId });

    let events = await readEventsSince(h.db.db, m.id, 0);
    for (let i = 0; i < 100 && events.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 50));
      events = await readEventsSince(h.db.db, m.id, 0);
    }
    expect(events.map((e) => [e.seq, e.type, e.actor])).toEqual([
      [1, "mission.created", expect.stringMatching(/^user:/)],
      [2, "mission.blocked", "system"],
    ]);
    expect(events[1]?.payload).toEqual({
      reason: "planning: no agents yet: add a connector and build an agent",
    });
    const detail = (await alice.request("GET", `/v1/missions/${m.id}`)).json();
    expect(detail.mission).toMatchObject({
      status: "draft",
      blockedReason: "planning: no agents yet: add a connector and build an agent",
    });
    expect(detail.tasks).toEqual([
      expect.objectContaining({ key: "brio.plan", status: "pending", planVersion: 0 }),
    ]);
    expect(detail.plan).toBeNull();

    const list = (await alice.request("GET", "/v1/missions")).json();
    expect(list.missions[0].id).toBe(m.id);
  });

  it("streams mission events over SSE and resumes from Last-Event-ID without gaps", async () => {
    const m = (await alice.request("POST", "/v1/missions", { goal: "Stream me" })).json().mission;
    const address = await h.server.app.listen({ port: 0, host: "127.0.0.1" });
    const emit = (n: number) =>
      h.server.ctx.events.append(h.db.db, {
        workspaceId: acmeId,
        missionId: m.id,
        type: "attempt.message",
        actor: "system",
        payload: { n },
      });

    async function collect(lastEventId: string | null, until: number) {
      const ac = new AbortController();
      const res = await fetch(`${address}/v1/missions/${m.id}/events`, {
        headers: { cookie: alice.cookieHeader, ...(lastEventId ? { "last-event-id": lastEventId } : {}) },
        signal: ac.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const seen: { id: number; event: string }[] = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx = buf.indexOf("\n\n");
        while (idx !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const id = /^id: (\d+)$/m.exec(frame)?.[1];
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          if (id && event) seen.push({ id: Number(id), event });
          idx = buf.indexOf("\n\n");
        }
        if (seen.at(-1)?.id === until) break;
      }
      ac.abort();
      return seen;
    }

    const first = collect(null, 4);
    await new Promise((r) => setTimeout(r, 100));
    await emit(3);
    await emit(4);
    expect((await first).map((e) => e.id)).toEqual([1, 2, 3, 4]);
    expect((await first)[0]?.event).toBe("mission.created");

    for (let n = 5; n <= 8; n++) await emit(n); // written while disconnected
    const second = collect("4", 10);
    await new Promise((r) => setTimeout(r, 100));
    await Promise.all([emit(9), emit(10)]);
    expect((await second).map((e) => e.id)).toEqual([5, 6, 7, 8, 9, 10]);
  });

  it("does not stream another workspace's mission", async () => {
    const m = (await alice.request("POST", "/v1/missions", { goal: "private" })).json().mission;
    const eve = new Client(h);
    await eve.signIn("eve2@example.com");
    expect((await eve.request("GET", `/v1/missions/${m.id}/events`)).statusCode).toBe(404);
    expect((await eve.request("GET", `/v1/missions/${m.id}`)).statusCode).toBe(404);
  });

  it("a planted vault secret never appears in logs or events", async () => {
    const planted = `sk-planted-${randomBytes(16).toString("hex")}`;
    const vault = new Vault(new LocalKeyProvider([randomBytes(32)]), h.redactor);
    await vault.put(h.db.db, { workspaceId: acmeId, label: "openai", value: planted });

    const res = await alice.request(
      "POST",
      `/v1/missions?debug=${planted}`,
      { goal: `Use key ${planted} to call the API` },
      {
        "x-debug": planted,
      },
    );
    expect(res.statusCode).toBe(201);
    await alice.request("POST", `/v1/missions`, { goal: "", note: planted });
    h.server.app.log.error({ detail: `oops ${planted}` }, `failure with ${planted}`);

    const logs = h.logs.join("");
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(planted);
    const dump = await h.db.db.execute(sql`select payload::text as p from events`);
    expect(JSON.stringify(dump.rows)).not.toContain(planted);
    const ledgerDump = await h.db.db.execute(sql`select payload::text as p from ledger`);
    expect(JSON.stringify(ledgerDump.rows)).not.toContain(planted);
    const [row] = await h.db.db
      .select()
      .from(schema.vaultSecrets)
      .where(eq(schema.vaultSecrets.label, "openai"));
    expect(row!.ciphertext.includes(Buffer.from(planted))).toBe(false);
  });

  it("soft-deletes a workspace (owner only)", async () => {
    const tmp = (await alice.request("POST", "/v1/workspaces", { name: "Tmp" })).json().workspace;
    expect((await alice.request("DELETE", `/v1/workspaces/${tmp.id}`)).statusCode).toBe(204);
    const list = (await alice.request("GET", "/v1/workspaces")).json();
    expect(list.workspaces.map((w: { id: string }) => w.id)).not.toContain(tmp.id);
    expect((await bob.request("DELETE", `/v1/workspaces/${acmeId}`)).statusCode).toBe(403);
  });
});
