// D-107: a Brio on a public address can limit who may sign up. Listed addresses and domains may; so may anyone with a
// pending invitation; existing accounts always sign in. Nobody else is sent a sign-in link at all. Needs Postgres.
import { hasTestDatabase } from "@brio/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signupAllowList } from "../src/signup";
import { Client, type Harness, startHarness } from "./helpers";

describe("the allow list", () => {
  it("is open when unset, and reads addresses and domains", () => {
    expect(signupAllowList(undefined)).toBeNull();
    expect(signupAllowList(" Owner@Example.com, @Team.example\n x@y.z ")).toEqual([
      "owner@example.com",
      "@team.example",
      "x@y.z",
    ]);
  });
});

describe.skipIf(!hasTestDatabase)("D-107: sign-up by invitation", () => {
  let h: Harness;
  const outbox = async (email: string) =>
    (
      await h.server.app.inject({ method: "GET", url: `/v1/dev/outbox?email=${encodeURIComponent(email)}` })
    ).json().messages as Array<{ subject: string; link: string }>;

  beforeAll(async () => {
    h = await startHarness({ runner: false, env: { BRIO_SIGNUP_ALLOW: "owner@example.com, @team.example" } });
  });
  afterAll(async () => {
    await h?.close();
  });

  it("lets listed addresses and domains sign up", async () => {
    await new Client(h).signIn("owner@example.com");
    await new Client(h).signIn("Someone@TEAM.example".toLowerCase());
  });

  it("refuses anyone else, and sends them nothing", async () => {
    const stranger = new Client(h);
    const res = await stranger.request("POST", "/api/auth/sign-in/magic-link", {
      email: "stranger@elsewhere.example",
      callbackURL: "/missions",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/by invitation/);
    expect(await outbox("stranger@elsewhere.example")).toEqual([]);
    // A look-alike domain is not the listed one.
    const lookalike = await stranger.request("POST", "/api/auth/sign-in/magic-link", {
      email: "x@evilteam.example",
      callbackURL: "/missions",
    });
    expect(lookalike.statusCode).toBe(403);
  });

  it("lets an invited person join, and anyone with an account sign in again", async () => {
    const owner = new Client(h);
    await owner.signIn("owner@example.com");
    const ws = (await owner.request("POST", "/v1/workspaces", { name: "Closed" })).json().workspace.id;
    const invite = await owner.request("POST", `/v1/workspaces/${ws}/invitations`, {
      email: "guest@elsewhere.example",
    });
    expect(invite.statusCode, invite.body).toBe(201);
    const guest = new Client(h);
    await guest.signIn("guest@elsewhere.example");
    const accept = await guest.request("POST", "/api/auth/organization/accept-invitation", {
      invitationId: invite.json().invitation.id,
    });
    expect(accept.statusCode, accept.body).toBe(200);
    // Their invitation is used up; their account stays.
    await new Client(h).signIn("guest@elsewhere.example");
  });
});
