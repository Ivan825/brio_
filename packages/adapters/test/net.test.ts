import { describe, expect, it } from "vitest";
import { AdapterError } from "../src/errors";
import { assertSafeUrl, guardedFetch } from "../src/net";

const resolveTo = (ip: string) => async () => [ip];
const strict = { allowPrivate: false, allowHttp: false };
const open = { allowPrivate: true, allowHttp: true };

describe("URL guard", () => {
  it("allows public https", async () => {
    await expect(
      assertSafeUrl("https://api.vendor.test/v1", strict, resolveTo("203.0.113.10")),
    ).resolves.toBeInstanceOf(URL);
  });

  it("always blocks cloud metadata and link-local, even when private networks are allowed", async () => {
    for (const url of ["http://169.254.169.254/latest", "http://[fe80::1]/", "http://100.100.100.200/"])
      await expect(assertSafeUrl(url, open)).rejects.toMatchObject({ code: "unsafe_url" });
    await expect(
      assertSafeUrl("http://metadata.test/", open, resolveTo("169.254.169.254")),
    ).rejects.toMatchObject({
      code: "unsafe_url",
    });
    await expect(
      assertSafeUrl("http://x.test/", open, resolveTo("::ffff:169.254.169.254")),
    ).rejects.toMatchObject({
      code: "unsafe_url",
    });
  });

  it("blocks private networks and plain http unless allowed", async () => {
    await expect(
      assertSafeUrl("https://intranet.test/", strict, resolveTo("10.1.2.3")),
    ).rejects.toMatchObject({
      code: "unsafe_url",
    });
    await expect(
      assertSafeUrl("http://api.vendor.test/", strict, resolveTo("203.0.113.10")),
    ).rejects.toMatchObject({
      code: "unsafe_url",
    });
    await expect(
      assertSafeUrl("http://localhost:11434/v1", open, resolveTo("127.0.0.1")),
    ).resolves.toBeInstanceOf(URL);
  });

  it("rejects other protocols and credentials in URLs", async () => {
    await expect(assertSafeUrl("file:///etc/passwd", open)).rejects.toBeInstanceOf(AdapterError);
    await expect(
      assertSafeUrl("https://user:pw@api.vendor.test/", open, resolveTo("203.0.113.10")),
    ).rejects.toMatchObject({
      code: "unsafe_url",
    });
  });

  it("guards every request and refuses redirects", async () => {
    const seen: RequestInit[] = [];
    const f = guardedFetch(
      async (_u, init) => {
        seen.push(init ?? {});
        return new Response("{}");
      },
      strict,
      resolveTo("203.0.113.10"),
    );
    await f("https://api.vendor.test/v1/models");
    expect(seen[0]?.redirect).toBe("error");
    const blocked = guardedFetch(async () => new Response("{}"), strict, resolveTo("10.0.0.1"));
    await expect(blocked("https://api.vendor.test/")).rejects.toMatchObject({ code: "unsafe_url" });
  });
});
