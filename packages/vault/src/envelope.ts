import { randomBytes } from "node:crypto";
import {
  canonicalContext,
  type EncryptionContext,
  type KeyProvider,
  openAesGcm,
  sealAesGcm,
  VaultError,
} from "./keys";

export interface SealedSecret {
  /** AES-256-GCM under the data key: iv || tag || ciphertext. */
  ciphertext: Buffer;
  /** The data key, wrapped by the KEK. */
  dekWrapped: Buffer;
  kekProvider: string;
  kekId: string;
}

/** The context binds a sealed secret to its workspace and label, so rows cannot be swapped. */
export function secretContext(workspaceId: string, label: string): EncryptionContext {
  return { purpose: "brio-vault", workspaceId, label };
}

/** Envelope encryption: a fresh 256-bit data key per secret, wrapped by the provider's KEK. */
export async function seal(
  plaintext: string,
  provider: KeyProvider,
  context: EncryptionContext,
): Promise<SealedSecret> {
  const dek = randomBytes(32);
  try {
    const ciphertext = sealAesGcm(dek, Buffer.from(plaintext, "utf8"), canonicalContext(context));
    const { wrapped, kekId } = await provider.wrapKey(dek, context);
    return { ciphertext, dekWrapped: wrapped, kekProvider: provider.name, kekId };
  } finally {
    dek.fill(0);
  }
}

export async function open(
  sealed: SealedSecret,
  provider: KeyProvider,
  context: EncryptionContext,
): Promise<string> {
  if (sealed.kekProvider !== provider.name) {
    throw new VaultError(
      `secret was sealed by ${sealed.kekProvider}, but the vault is using ${provider.name}`,
    );
  }
  const dek = await provider.unwrapKey(sealed.dekWrapped, sealed.kekId, context);
  try {
    return openAesGcm(dek, sealed.ciphertext, canonicalContext(context)).toString("utf8");
  } finally {
    dek.fill(0);
  }
}

/** Re-wrap the data key under the provider's current KEK without touching the ciphertext. */
export async function rewrap(
  sealed: SealedSecret,
  provider: KeyProvider,
  context: EncryptionContext,
): Promise<SealedSecret> {
  if (sealed.kekId === provider.currentKekId) return sealed;
  const dek = await provider.unwrapKey(sealed.dekWrapped, sealed.kekId, context);
  try {
    const { wrapped, kekId } = await provider.wrapKey(dek, context);
    return { ...sealed, dekWrapped: wrapped, kekId, kekProvider: provider.name };
  } finally {
    dek.fill(0);
  }
}
