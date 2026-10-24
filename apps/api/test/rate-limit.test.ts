// Security review L1: a ceiling on requests per client address, with the health check, live event streams and
// runners' sockets left out of it. Needs Postgres.
import { hasTestDatabase } from "@brio/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./helpers";

describe.skipIf(!hasTestDatabase)("rate limit", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ runner: false, env: { BRIO_RATE_LIMIT_PER_MINUTE: "5" } });
  });
  afterAll(async () => {
    await h?.close();
  });

  it("refuses an address past its requests per minute, but never the health check", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++)
      statuses.push((await h.server.app.inject({ method: "GET", url: "/v1/registry" })).statusCode);
    expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
    // Another address has its own allowance; the health check has none.
    expect(
      (await h.server.app.inject({ method: "GET", url: "/v1/registry", remoteAddress: "198.51.100.7" }))
        .statusCode,
    ).not.toBe(429);
    for (let i = 0; i < 10; i++)
      expect((await h.server.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });
});
