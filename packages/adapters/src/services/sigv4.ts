// AWS Signature Version 4 (for Bedrock AgentCore and Nova Act): the documented algorithm, with node:crypto. Tested
// against AWS's own SigV4 test-suite vectors.
import { createHash, createHmac } from "node:crypto";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const hmac = (key: string | Buffer, s: string) => createHmac("sha256", key).update(s).digest();
/** RFC 3986 encoding, as SigV4 wants it. */
const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * The headers to add to a request (Authorization, X-Amz-Date, and the session token when there is one). Paths are
 * encoded once more for the canonical request, as every AWS service but S3 expects.
 */
export function signV4(
  req: { method: string; url: string; headers: Record<string, string>; body: string | Uint8Array },
  creds: AwsCredentials,
  region: string,
  service: string,
  now: Date = new Date(),
): Record<string, string> {
  const url = new URL(req.url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")]),
    ),
    host: url.host,
    "x-amz-date": amzDate,
    ...(creds.sessionToken ? { "x-amz-security-token": creds.sessionToken } : {}),
  };
  const names = Object.keys(headers).sort();
  const canonicalPath =
    url.pathname
      .split("/")
      .map((seg) => enc(decodeURIComponent(seg)))
      .map((seg) => enc(seg))
      .join("/") || "/";
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [
    req.method.toUpperCase(),
    canonicalPath,
    query,
    ...names.map((n) => `${n}:${headers[n]}`),
    "",
    names.join(";"),
    sha256(req.body),
  ].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, day), region), service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return {
    "x-amz-date": amzDate,
    ...(creds.sessionToken ? { "x-amz-security-token": creds.sessionToken } : {}),
    authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}
