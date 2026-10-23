import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Bound into every wrap/unwrap so a wrapped key only opens for the secret it was made for. */
export type EncryptionContext = Readonly<Record<string, string>>;

/** A key-encryption key (KEK) holder. Wraps and unwraps per-secret data keys (DEKs); never sees secrets. */
export interface KeyProvider {
  readonly name: string;
  readonly currentKekId: string;
  wrapKey(dek: Buffer, context: EncryptionContext): Promise<{ wrapped: Buffer; kekId: string }>;
  unwrapKey(wrapped: Buffer, kekId: string, context: EncryptionContext): Promise<Buffer>;
}

export class VaultError extends Error {
  override name = "VaultError";
}

export function canonicalContext(context: EncryptionContext): Buffer {
  const sorted = Object.keys(context)
    .sort()
    .map((k) => [k, context[k]]);
  return Buffer.from(JSON.stringify(sorted));
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM; output is iv || tag || ciphertext. */
export function sealAesGcm(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function openAesGcm(key: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  if (sealed.length < IV_BYTES + TAG_BYTES) throw new VaultError("ciphertext is truncated");
  const iv = sealed.subarray(0, IV_BYTES);
  const tag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
  } catch {
    throw new VaultError("decryption failed: wrong key, wrong context or tampered data");
  }
}

/**
 * KEKs held by this process (BRIO_VAULT_LOCAL_KEK). For self-host and development. The first key is current; the
 * rest stay readable so secrets wrapped before a rotation still open.
 */
export class LocalKeyProvider implements KeyProvider {
  readonly name = "local";
  private readonly keys = new Map<string, Buffer>();
  readonly currentKekId: string;

  constructor(keys: readonly Buffer[]) {
    if (keys.length === 0) throw new VaultError("LocalKeyProvider needs at least one key");
    for (const k of keys) {
      if (k.length !== 32) throw new VaultError("local KEKs must be 32 bytes (openssl rand -base64 32)");
      this.keys.set(LocalKeyProvider.idOf(k), k);
    }
    this.currentKekId = LocalKeyProvider.idOf(keys[0] as Buffer);
  }

  static idOf(key: Buffer): string {
    return `local:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
  }

  /** Parses a comma-separated list of base64 keys, current first. */
  static fromBase64(list: string): LocalKeyProvider {
    return new LocalKeyProvider(
      list
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => Buffer.from(s, "base64")),
    );
  }

  async wrapKey(dek: Buffer, context: EncryptionContext) {
    const kek = this.keys.get(this.currentKekId) as Buffer;
    return { wrapped: sealAesGcm(kek, dek, canonicalContext(context)), kekId: this.currentKekId };
  }

  async unwrapKey(wrapped: Buffer, kekId: string, context: EncryptionContext) {
    const kek = this.keys.get(kekId);
    if (!kek) throw new VaultError(`unknown local KEK ${kekId}`);
    return openAesGcm(kek, wrapped, canonicalContext(context));
  }
}
