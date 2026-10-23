import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { type DecryptCommand, EncryptCommand } from "@aws-sdk/client-kms";
import { describe, expect, it } from "vitest";
import { AwsKmsKeyProvider, type KmsLike } from "../src/aws-kms";
import { keyProviderFromEnv } from "../src/config";
import { open, rewrap, seal, secretContext } from "../src/envelope";
import { canonicalContext, LocalKeyProvider, openAesGcm, sealAesGcm, VaultError } from "../src/keys";
import { SecretValue } from "../src/secret-value";

const secret = "sk-test-0123456789abcdefghijklmnopqrstuv";
const ctx = secretContext("ws-1", "openai");

describe("envelope encryption with the local provider", () => {
  const provider = new LocalKeyProvider([randomBytes(32)]);

  it("round-trips a secret", async () => {
    const sealed = await seal(secret, provider, ctx);
    expect(await open(sealed, provider, ctx)).toBe(secret);
  });

  it("never stores the plaintext or the data key in the clear", async () => {
    const sealed = await seal(secret, provider, ctx);
    expect(sealed.ciphertext.includes(Buffer.from(secret))).toBe(false);
    expect(sealed.dekWrapped).toHaveLength(12 + 16 + 32);
    expect(sealed.kekId).toBe(provider.currentKekId);
  });

  it("uses a fresh data key and IV every time", async () => {
    const a = await seal(secret, provider, ctx);
    const b = await seal(secret, provider, ctx);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.dekWrapped.equals(b.dekWrapped)).toBe(false);
  });

  it("detects tampering with the ciphertext or the wrapped key", async () => {
    const sealed = await seal(secret, provider, ctx);
    const flip = (b: Buffer, i: number) => {
      const c = Buffer.from(b);
      c[i] = (c[i] as number) ^ 1;
      return c;
    };
    await expect(open({ ...sealed, ciphertext: flip(sealed.ciphertext, 30) }, provider, ctx)).rejects.toThrow(
      VaultError,
    );
    await expect(open({ ...sealed, dekWrapped: flip(sealed.dekWrapped, 40) }, provider, ctx)).rejects.toThrow(
      VaultError,
    );
  });

  it("binds a secret to its workspace and label", async () => {
    const sealed = await seal(secret, provider, ctx);
    await expect(open(sealed, provider, secretContext("ws-2", "openai"))).rejects.toThrow(VaultError);
    await expect(open(sealed, provider, secretContext("ws-1", "anthropic"))).rejects.toThrow(VaultError);
  });

  it("fails with a different KEK", async () => {
    const sealed = await seal(secret, provider, ctx);
    const other = new LocalKeyProvider([randomBytes(32)]);
    await expect(open(sealed, other, ctx)).rejects.toThrow(/unknown local KEK/);
  });

  it("rotates: old secrets still open, rewrap moves them to the new KEK", async () => {
    const oldKey = randomBytes(32);
    const before = new LocalKeyProvider([oldKey]);
    const sealed = await seal(secret, before, ctx);
    const newKey = randomBytes(32);
    const after = new LocalKeyProvider([newKey, oldKey]);
    expect(await open(sealed, after, ctx)).toBe(secret);
    const moved = await rewrap(sealed, after, ctx);
    expect(moved.kekId).toBe(after.currentKekId);
    expect(moved.ciphertext.equals(sealed.ciphertext)).toBe(true);
    expect(await open(moved, new LocalKeyProvider([newKey]), ctx)).toBe(secret);
  });

  it("rejects KEKs of the wrong size", () => {
    expect(() => new LocalKeyProvider([randomBytes(16)])).toThrow(/32 bytes/);
    expect(() => new LocalKeyProvider([])).toThrow();
  });
});

/** A stand-in for KMS: keeps its own key, enforces the encryption context like the real service. */
class FakeKms implements KmsLike {
  private readonly key = randomBytes(32);
  calls: string[] = [];
  async send(command: EncryptCommand | DecryptCommand) {
    if (command instanceof EncryptCommand) {
      this.calls.push(`encrypt:${command.input.KeyId}`);
      const blob = sealAesGcm(
        this.key,
        Buffer.from(command.input.Plaintext as Uint8Array),
        canonicalContext(command.input.EncryptionContext ?? {}),
      );
      return { CiphertextBlob: blob, KeyId: command.input.KeyId };
    }
    this.calls.push(`decrypt:${command.input.KeyId}`);
    try {
      const pt = openAesGcm(
        this.key,
        Buffer.from(command.input.CiphertextBlob as Uint8Array),
        canonicalContext(command.input.EncryptionContext ?? {}),
      );
      return { Plaintext: pt, KeyId: command.input.KeyId };
    } catch {
      throw Object.assign(new Error("InvalidCiphertextException"), { name: "InvalidCiphertextException" });
    }
  }
}

describe("envelope encryption with the AWS KMS provider", () => {
  const keyId = "arn:aws:kms:eu-west-1:123456789012:key/test";

  it("round-trips through KMS Encrypt/Decrypt with the context bound", async () => {
    const kms = new FakeKms();
    const provider = new AwsKmsKeyProvider(keyId, kms);
    const sealed = await seal(secret, provider, ctx);
    expect(sealed.kekId).toBe(`aws-kms:${keyId}`);
    expect(await open(sealed, provider, ctx)).toBe(secret);
    expect(kms.calls).toEqual([`encrypt:${keyId}`, `decrypt:${keyId}`]);
  });

  it("surfaces a KMS refusal as a VaultError without leaking details", async () => {
    const provider = new AwsKmsKeyProvider(keyId, new FakeKms());
    const sealed = await seal(secret, provider, ctx);
    await expect(open(sealed, provider, secretContext("ws-x", "openai"))).rejects.toThrow(
      "KMS Decrypt failed: InvalidCiphertextException",
    );
  });

  it("refuses to open a secret sealed by another provider", async () => {
    const sealed = await seal(secret, new LocalKeyProvider([randomBytes(32)]), ctx);
    await expect(open(sealed, new AwsKmsKeyProvider(keyId, new FakeKms()), ctx)).rejects.toThrow(
      /sealed by local/,
    );
  });
});

describe("keyProviderFromEnv", () => {
  it("builds a local provider by default", () => {
    const p = keyProviderFromEnv({ BRIO_VAULT_LOCAL_KEK: randomBytes(32).toString("base64") });
    expect(p.name).toBe("local");
  });
  it("fails closed without a key", () => {
    expect(() => keyProviderFromEnv({})).toThrow(/BRIO_VAULT_LOCAL_KEK/);
    expect(() => keyProviderFromEnv({ BRIO_KMS_PROVIDER: "aws" })).toThrow(/KMS key id/);
    expect(() => keyProviderFromEnv({ BRIO_KMS_PROVIDER: "gcp" })).toThrow(/unknown/);
  });
});

describe("SecretValue", () => {
  it("never prints itself", () => {
    const v = new SecretValue(secret);
    expect(`${v}`).toBe("[redacted]");
    expect(JSON.stringify({ v })).toBe('{"v":"[redacted]"}');
    expect(inspect(v)).not.toContain(secret);
    expect(v.reveal()).toBe(secret);
  });
});
