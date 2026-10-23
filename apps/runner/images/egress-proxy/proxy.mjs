// The egress proxy for one sandbox (SECURITY_GOVERNANCE §3: default deny). The sandbox sits on an internal Docker
// network with no route out; this proxy is its only way to the internet, and it forwards only to allow-listed hosts,
// never to private, loopback, link-local or metadata addresses (unless BRIO_PROXY_ALLOW_PRIVATE=true, for tests).
// Plain HTTP and HTTPS CONNECT; every decision is logged as one JSON line.
import { lookup } from "node:dns/promises";
import { createServer, request } from "node:http";
import { BlockList, connect, isIP } from "node:net";

const PORT = Number(process.env.BRIO_PROXY_PORT ?? 3128);
const ALLOW = (process.env.BRIO_PROXY_ALLOW ?? "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);
const ALLOW_PRIVATE = process.env.BRIO_PROXY_ALLOW_PRIVATE === "true";

const blocked = new BlockList();
for (const [net, bits, fam] of [
  ["169.254.0.0", 16, "ipv4"],
  ["100.100.100.200", 32, "ipv4"],
  ["0.0.0.0", 8, "ipv4"],
  ["fe80::", 10, "ipv6"],
])
  blocked.addSubnet(net, bits, fam);
const priv = new BlockList();
for (const [net, bits, fam] of [
  ["10.0.0.0", 8, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"],
])
  priv.addSubnet(net, bits, fam);

const log = (o) => process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), ...o })}\n`);

function hostAllowed(host) {
  const h = host.toLowerCase().replace(/\.$/, "");
  return ALLOW.some((rule) =>
    rule.startsWith(".") ? h.endsWith(rule) && h.length > rule.length : h === rule,
  );
}

async function resolveSafe(host) {
  if (!hostAllowed(host)) return { ok: false, why: "host not allowed" };
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  for (const ip of addrs) {
    const plain = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
    const fam = isIP(plain) === 6 ? "ipv6" : "ipv4";
    if (blocked.check(plain, fam)) return { ok: false, why: "blocked address" };
    if (!ALLOW_PRIVATE && priv.check(plain, fam)) return { ok: false, why: "private address" };
  }
  return { ok: true, ip: addrs[0] };
}

const server = createServer(async (req, res) => {
  // A client that resets mid-request must never take the proxy down.
  req.on("error", () => res.destroy());
  res.on("error", () => {});
  if (req.url === "/__health") {
    res.writeHead(200).end("ok");
    return;
  }
  let target;
  try {
    target = new URL(req.url ?? "");
  } catch {
    res.writeHead(400).end("absolute URL required");
    return;
  }
  if (target.protocol !== "http:") {
    res.writeHead(400).end("use CONNECT for https");
    return;
  }
  const verdict = await resolveSafe(target.hostname).catch(() => ({ ok: false, why: "dns failed" }));
  log({ method: req.method, host: target.hostname, allowed: verdict.ok, why: verdict.why });
  if (!verdict.ok) {
    res
      .writeHead(403, { "content-type": "text/plain" })
      .end(`brio egress: ${target.hostname} is not allowed\n`);
    return;
  }
  const upstream = request(
    {
      host: verdict.ip,
      port: target.port || 80,
      method: req.method,
      path: target.pathname + target.search,
      headers: { ...req.headers, host: target.host },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502).end("upstream error");
    else res.destroy();
  });
  req.pipe(upstream);
});

server.on("connect", async (req, socket, head) => {
  socket.on("error", () => socket.destroy());
  const [host, portStr] = (req.url ?? "").split(":");
  const port = Number(portStr || 443);
  const verdict = await resolveSafe(host ?? "").catch(() => ({ ok: false, why: "dns failed" }));
  log({ method: "CONNECT", host, port, allowed: verdict.ok, why: verdict.why });
  if (!verdict.ok || port !== 443) {
    socket.end(
      `HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nbrio egress: ${host} is not allowed\n`,
    );
    return;
  }
  const upstream = connect(port, verdict.ip, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.on("clientError", (_err, socket) => socket.destroy());

server.listen(PORT, "0.0.0.0", () => log({ listening: PORT, allow: ALLOW }));

// The Brio mailbox: the only service on the runner host a sandbox may reach. Requests to this listener (the proxy's
// alias brio-mailbox:8080) are relayed to the runner's mailbox server; the bearer token decides which attempt speaks.
const MAILBOX = process.env.BRIO_PROXY_MAILBOX_UPSTREAM;
if (MAILBOX) {
  const [mhost, mport] = MAILBOX.split(":");
  createServer((req, res) => {
    req.on("error", () => res.destroy());
    const up = request(
      { host: mhost, port: Number(mport), method: req.method, path: req.url, headers: req.headers },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on("error", () => {
      if (!res.headersSent) res.writeHead(502).end("mailbox unavailable");
      else res.destroy();
    });
    req.pipe(up);
  })
    .on("clientError", (_e, socket) => socket.destroy())
    .listen(8080, "0.0.0.0", () => log({ mailbox: MAILBOX }));
}
