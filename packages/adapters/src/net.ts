// Base URLs are user-supplied for local servers and proxies, so every request is checked before it leaves: no cloud
// metadata endpoints ever, and no private networks unless the deployment allows them (self-host, local dev).
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { AdapterError } from "./errors";
import type { FetchLike } from "./types";

const alwaysBlocked = new BlockList();
alwaysBlocked.addSubnet("169.254.0.0", 16, "ipv4"); // link-local, incl. cloud metadata 169.254.169.254
alwaysBlocked.addSubnet("100.100.100.200", 32, "ipv4"); // Alibaba Cloud metadata
alwaysBlocked.addSubnet("0.0.0.0", 8, "ipv4");
alwaysBlocked.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
alwaysBlocked.addSubnet("240.0.0.0", 4, "ipv4"); // reserved, incl. 255.255.255.255
alwaysBlocked.addSubnet("fe80::", 10, "ipv6");
alwaysBlocked.addAddress("fd00:ec2::254", "ipv6"); // AWS IMDS over IPv6

const privateRanges = new BlockList();
privateRanges.addSubnet("10.0.0.0", 8, "ipv4");
privateRanges.addSubnet("172.16.0.0", 12, "ipv4");
privateRanges.addSubnet("192.168.0.0", 16, "ipv4");
privateRanges.addSubnet("127.0.0.0", 8, "ipv4");
privateRanges.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT
privateRanges.addSubnet("198.18.0.0", 15, "ipv4"); // benchmarking, used inside some networks
privateRanges.addSubnet("::", 96, "ipv6"); // :: (this host), ::1, and IPv4-compatible ::a.b.c.d
privateRanges.addSubnet("fc00::", 7, "ipv6"); // unique local
privateRanges.addSubnet("64:ff9b:1::", 48, "ipv6"); // NAT64 for local use
privateRanges.addSubnet("2001::", 32, "ipv6"); // Teredo (its IPv4 address is obfuscated)

/**
 * The IPv4 address an IPv6 address carries, if any — IPv4-mapped (::ffff:a.b.c.d, also written ::ffff:7f00:1),
 * IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96) and 6to4 (2002:aabb:ccdd::) — so it is judged as that address.
 */
export function embeddedIpv4(ip: string): string | null {
  if (isIP(ip) !== 6) return null;
  const groups = expandIpv6(ip);
  if (!groups) return null;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zero = (from: number, to: number) => groups.slice(from, to).every((g) => g === 0);
  if (zero(0, 5) && groups[5] === 0xffff) return v4(groups[6]!, groups[7]!);
  if (zero(0, 4) && groups[4] === 0xffff && groups[5] === 0) return v4(groups[6]!, groups[7]!); // IPv4-translated
  if (zero(0, 6) && (groups[6] !== 0 || groups[7]! > 1)) return v4(groups[6]!, groups[7]!);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zero(2, 6)) return v4(groups[6]!, groups[7]!);
  if (groups[0] === 0x2002) return v4(groups[1]!, groups[2]!);
  return null;
}

/** The eight 16-bit groups of an IPv6 address (with a trailing dotted IPv4 part folded in). */
function expandIpv6(ip: string): number[] | null {
  let text = ip.toLowerCase().split("%")[0] ?? "";
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1]) {
    const [a, b, c, d] = dotted[1].split(".").map(Number) as [number, number, number, number];
    text = `${text.slice(0, -dotted[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail === undefined ? [] : tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? left.length !== 8 : missing < 0) return null;
  const all = [...left, ...Array.from({ length: tail === undefined ? 0 : missing }, () => "0"), ...right];
  const groups = all.map((g) => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

/** Why an address may not be reached under the policy, or null when it may. */
export function addressRefusal(ip: string, policy: Pick<UrlPolicy, "allowPrivate">): string | null {
  for (const a of [ip, embeddedIpv4(ip)].filter((x): x is string => Boolean(x))) {
    if (alwaysBlocked.check(a, family(a))) return "a blocked address";
    if (!policy.allowPrivate && privateRanges.check(a, family(a)))
      return "a private address; private networks are disabled here";
  }
  return null;
}

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
    const why = addressRefusal(ip, policy);
    if (why) throw new AdapterError("unsafe_url", `${host} resolves to ${why}`);
  }
  return url;
}

/**
 * Wraps fetch so every request URL passes assertSafeUrl and redirects are not followed blindly: they are an error,
 * unless the caller asks for "manual" and checks each hop itself (followRedirects does).
 */
export function guardedFetch(
  inner: FetchLike,
  policy: UrlPolicy,
  resolve: Resolver = systemResolver,
): FetchLike {
  // On the real network, connections go only to addresses checked as they are looked up (pinnedFetch).
  const base = inner === globalThis.fetch ? pinnedFetch(policy) : inner;
  return async (input, init) => {
    await assertSafeUrl(input, policy, resolve);
    return base(input, { ...init, redirect: init?.redirect === "manual" ? "manual" : "error" });
  };
}

/**
 * fetch whose connections go only to addresses that pass the policy, checked in the connection's own DNS lookup.
 * A name that resolves to a public address when checked and to 127.0.0.1 or 169.254.169.254 a moment later (DNS
 * rebinding) cannot get past it: there is no second, unchecked lookup.
 */
export function pinnedFetch(policy: Pick<UrlPolicy, "allowPrivate">): FetchLike {
  const agent = new Agent({
    connect: {
      lookup: (hostname, options, callback) => {
        lookup(hostname, { all: true }).then(
          (found) => {
            const allowed = found.filter((a) => !addressRefusal(a.address, policy));
            if (!allowed.length) {
              const why = found[0] ? addressRefusal(found[0].address, policy) : "no address";
              callback(new AdapterError("unsafe_url", `${hostname} resolves to ${why}`), "", 4);
              return;
            }
            if ((options as { all?: boolean }).all)
              (callback as (e: null, a: typeof allowed) => void)(null, allowed);
            else callback(null, allowed[0]!.address, allowed[0]!.family);
          },
          (err: Error) => callback(err as NodeJS.ErrnoException, "", 4),
        );
      },
    },
  });
  return async (input, init = {}) => {
    let body = init.body;
    let headers = new Headers(init.headers);
    // Bodies undici's own classes would not recognise (the runtime's FormData, Blob, URLSearchParams) go as bytes,
    // with the content type (multipart boundary included) the runtime gives them.
    if (body instanceof FormData || body instanceof Blob || body instanceof URLSearchParams) {
      const encoded = new Request("http://encode.invalid/", { method: "POST", body });
      if (!headers.has("content-type"))
        headers.set("content-type", encoded.headers.get("content-type") ?? "");
      body = new Uint8Array(await encoded.arrayBuffer());
    }
    if (!headers.get("content-type"))
      headers = new Headers([...headers].filter(([k]) => k !== "content-type"));
    return undiciFetch(String(input), {
      ...(init as object),
      body,
      headers,
      dispatcher: agent,
    } as unknown as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
  };
}

/** Follows up to `maxHops` redirects through a guarded fetch, so every hop passes the URL guard again. */
export async function followRedirects(
  fetch: FetchLike,
  url: string,
  init: RequestInit = {},
  maxHops = 5,
): Promise<{ response: Response; url: string }> {
  let current = url;
  for (let hop = 0; ; hop++) {
    const response = await fetch(current, { ...init, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) return { response, url: current };
    if (hop >= maxHops) throw new AdapterError("network", `too many redirects from ${url}`);
    await response.body?.cancel().catch(() => {});
    current = new URL(location, current).toString();
  }
}
