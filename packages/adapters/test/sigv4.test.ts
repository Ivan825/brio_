import { describe, expect, it } from "vitest";
import { signV4 } from "../src/services/sigv4";

// AWS's SigV4 test suite (aws-sig-v4-test-suite): example credentials, us-east-1, service "service", 30 Aug 2015.
const creds = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: ["wJalrXUtnFEMI", "K7MDENG+bPxRfiCYEXAMPLEKEY"].join("/"),
};
const at = new Date("2015-08-30T12:36:00Z");

describe("SigV4", () => {
  it("matches get-vanilla", () => {
    const h = signV4(
      { method: "GET", url: "https://example.amazonaws.com/", headers: {}, body: "" },
      creds,
      "us-east-1",
      "service",
      at,
    );
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
    expect(h["x-amz-date"]).toBe("20150830T123600Z");
  });

  it("matches post-vanilla", () => {
    const h = signV4(
      { method: "POST", url: "https://example.amazonaws.com/", headers: {}, body: "" },
      creds,
      "us-east-1",
      "service",
      at,
    );
    expect(h.authorization).toContain(
      "Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b",
    );
  });

  it("adds the session token and signs it", () => {
    const h = signV4(
      { method: "GET", url: "https://example.amazonaws.com/", headers: {}, body: "" },
      { ...creds, sessionToken: "tok" },
      "us-east-1",
      "service",
      at,
    );
    expect(h["x-amz-security-token"]).toBe("tok");
    expect(h.authorization).toContain("SignedHeaders=host;x-amz-date;x-amz-security-token");
  });
});
