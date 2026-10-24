// Environment parsing: a variable left blank in an env file counts as unset (self-host templates leave optional keys
// empty), and production refuses development-only switches.
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const BASE = {
  DATABASE_URL: "postgres://brio:brio@localhost:5432/brio",
  BETTER_AUTH_SECRET: "x".repeat(40),
};

describe("loadConfig", () => {
  it("treats blank optional variables as unset", () => {
    const c = loadConfig({
      ...BASE,
      RESEND_API_KEY: "",
      BRIO_VAPID_PUBLIC_KEY: " ",
      BRIO_VAPID_PRIVATE_KEY: "",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      BRIO_EMAIL_FROM: "",
    });
    expect(c.RESEND_API_KEY).toBeUndefined();
    expect(c.BRIO_VAPID_PUBLIC_KEY).toBeUndefined();
    expect(c.google).toBeNull();
    expect(c.BRIO_EMAIL_FROM).toBe("Brio <onboarding@resend.dev>");
  });

  it("still refuses a value that is set but wrong", () => {
    expect(() => loadConfig({ ...BASE, BRIO_VAPID_PUBLIC_KEY: "short" })).toThrow(/BRIO_VAPID_PUBLIC_KEY/);
    expect(() => loadConfig({ ...BASE, BETTER_AUTH_SECRET: "" })).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("keeps development switches out of production", () => {
    expect(() => loadConfig({ ...BASE, NODE_ENV: "production", BRIO_DEV_OUTBOX: "true" })).toThrow(
      /production/,
    );
    const prod = loadConfig({ ...BASE, NODE_ENV: "production" });
    expect(prod.allowPrivateUrls).toBe(false);
    expect(prod.allowLocalRepos).toBe(false);
  });
});
