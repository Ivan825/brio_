import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdapterError } from "../src/errors";
import { addressRefusal, assertSafeUrl, embeddedIpv4, guardedFetch, pinnedFetch } from "../src/net";

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

describe("URL guard: addresses in disguise (security review M2)", () => {
  it("judges an IPv6 address by the IPv4 address it carries", () => {
    expect(embeddedIpv4("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(embeddedIpv4("::ffff:7f00:1")).toBe("127.0.0.1");
    expect(embeddedIpv4("::a9fe:a9fe")).toBe("169.254.169.254");
    expect(embeddedIpv4("64:ff9b::a9fe:a9fe")).toBe("169.254.169.254");
    expect(embeddedIpv4("2002:a9fe:a9fe::1")).toBe("169.254.169.254");
    expect(embeddedIpv4("2606:4700::1111")).toBeNull();
    expect(embeddedIpv4("::1")).toBeNull();
  });

  it("refuses this host, loopback, private and metadata addresses in every IPv6 form", () => {
    for (const ip of [
      "::",
      "::1",
      "::ffff:7f00:1",
      "::ffff:10.0.0.1",
      "64:ff9b::a00:1",
      "2002:c0a8:101::1",
      "fd12::1",
    ])
      expect(addressRefusal(ip, strict), ip).toMatch(/private/);
    for (const ip of ["::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::", "::a9fe:a9fe"])
      expect(addressRefusal(ip, open), ip).toMatch(/blocked/);
    for (const ip of ["2606:4700::1111", "::ffff:8.8.8.8", "203.0.113.10"])
      expect(addressRefusal(ip, strict), ip).toBeNull();
  });

  it("refuses an unspecified-address URL", async () => {
    await expect(assertSafeUrl("https://[::]:8443/", strict)).rejects.toMatchObject({ code: "unsafe_url" });
    await expect(assertSafeUrl("https://[::ffff:7f00:1]/", strict)).rejects.toMatchObject({
      code: "unsafe_url",
    });
  });
});

describe("pinned connections (security review M2: DNS rebinding)", () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () =>
        res.end(JSON.stringify({ method: req.method, type: req.headers["content-type"] ?? null, body })),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.close();
  });

  it("connects only to an address checked in the connection's own lookup", async () => {
    // The guard's lookup says public (what a rebinding name answers first); the connection's lookup finds loopback.
    const rebinding = guardedFetch(
      globalThis.fetch,
      { allowPrivate: false, allowHttp: true },
      resolveTo("203.0.113.10"),
    );
    const err = await rebinding(`http://localhost:${port}/`).then(
      () => null,
      (e: Error & { cause?: Error }) => e,
    );
    expect(String(err?.cause?.message ?? err?.message)).toMatch(/private address/);
  });

  it("sends JSON, forms and files intact where it may connect", async () => {
    const f = pinnedFetch({ allowPrivate: true });
    const json = await (
      await f(`http://localhost:${port}/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: 1 }),
      })
    ).json();
    expect(json).toEqual({ method: "POST", type: "application/json", body: '{"a":1}' });
    const form = new FormData();
    form.append("file", new Blob(["hello"]), "a.txt");
    const sent = (await (await f(`http://127.0.0.1:${port}/`, { method: "POST", body: form })).json()) as {
      type: string;
      body: string;
    };
    expect(sent.type).toMatch(/^multipart\/form-data; boundary=/);
    expect(sent.body).toContain('filename="a.txt"');
    expect(sent.body).toContain("hello");
  });
});
