// Base URLs are user-supplied for local servers and proxies, so every request is checked before it leaves: no cloud
// metadata endpoints ever, and no private networks unless the deployment allows them (self-host, local dev).
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { AdapterError } from "./errors";
import type { FetchLike } from "./types";

const alwaysBlocked = new BlockList();
alwaysBlocked.addSubnet("169.254.0.0", 16, "ipv4"); // link-local, incl. cloud metadata 169.254.169.254
alwaysBlocked.addSubnet("100.100.100.200", 32, "ipv4"); // Alibaba Cloud metadata
alwaysBlocked.addSubnet("0.0.0.0", 8, "ipv4");
alwaysBlocked.addSubnet("fe80::", 10, "ipv6");
alwaysBlocked.addAddress("fd00:ec2::254", "ipv6"); // AWS IMDS over IPv6

const privateRanges = new BlockList();
privateRanges.addSubnet("10.0.0.0", 8, "ipv4");
privateRanges.addSubnet("172.16.0.0", 12, "ipv4");
privateRanges.addSubnet("192.168.0.0", 16, "ipv4");
privateRanges.addSubnet("127.0.0.0", 8, "ipv4");
privateRanges.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT
privateRanges.addSubnet("::1", 128, "ipv6");
privateRanges.addSubnet("fc00::", 7, "ipv6");

export interface UrlPolicy {
  /** Allow loopback and private networks (local models, self-hosted proxies). */
  allowPrivate: boolean;
  /** Allow plain http (only sensible together with allowPrivate). */
  allowHttp: boolean;
}

export type Resolver = (host: string) => Promise<string[]>;

const systemResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

function family(ip: string): "ipv4" | "ipv6" {
  return isIP(ip) === 6 ? "ipv6" : "ipv4";
}

/** Throws AdapterError("unsafe_url") unless the URL may be requested under the policy. */
export async function assertSafeUrl(
  raw: string | URL,
  policy: UrlPolicy,
  resolve: Resolver = systemResolver,
) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AdapterError("unsafe_url", "not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new AdapterError("unsafe_url", `protocol ${url.protocol} is not allowed`);
  if (url.protocol === "http:" && !policy.allowHttp)
    throw new AdapterError(
      "unsafe_url",
      "plain http is only allowed for local servers in self-hosted setups",
    );
  if (url.username || url.password)
    throw new AdapterError("unsafe_url", "credentials in URLs are not allowed");

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [host]
    : await resolve(host).catch(() => {
        throw new AdapterError("network", `cannot resolve ${host}`);
      });
  for (const ip of addresses) {
    const mapped = ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
    if (alwaysBlocked.check(mapped, family(mapped)))
      throw new AdapterError("unsafe_url", `${host} resolves to a blocked address`);
    if (!policy.allowPrivate && privateRanges.check(mapped, family(mapped)))
      throw new AdapterError(
        "unsafe_url",
        `${host} is a private address; private networks are disabled here`,
      );
  }
  return url;
}

/** Wraps fetch so every request URL passes assertSafeUrl and redirects are not followed blindly. */
export function guardedFetch(
  inner: FetchLike,
  policy: UrlPolicy,
  resolve: Resolver = systemResolver,
): FetchLike {
  return async (input, init) => {
    await assertSafeUrl(input, policy, resolve);
    return inner(input, { ...init, redirect: "error" });
  };
}
