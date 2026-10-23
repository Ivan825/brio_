import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { type EncryptionContext, type KeyProvider, VaultError } from "./keys";

/** The slice of KMSClient we use, so tests can supply a fake. */
export interface KmsLike {
  send(
    command: EncryptCommand | DecryptCommand,
  ): Promise<{ CiphertextBlob?: Uint8Array; Plaintext?: Uint8Array; KeyId?: string }>;
}

/**
 * KEK held in AWS KMS. Data keys are wrapped with kms:Encrypt under the configured key, with the encryption context
 * bound in (KMS refuses to decrypt under a different context). The key never leaves KMS.
 */
export class AwsKmsKeyProvider implements KeyProvider {
  readonly name = "aws-kms";
  readonly currentKekId: string;

  constructor(
    private readonly keyId: string,
    private readonly client: KmsLike = new KMSClient({}),
  ) {
    if (!keyId) throw new VaultError("AwsKmsKeyProvider needs a KMS key id or ARN");
    this.currentKekId = `aws-kms:${keyId}`;
  }

  async wrapKey(dek: Buffer, context: EncryptionContext) {
    const res = await this.client.send(
      new EncryptCommand({ KeyId: this.keyId, Plaintext: dek, EncryptionContext: { ...context } }),
    );
    if (!res.CiphertextBlob) throw new VaultError("KMS Encrypt returned no ciphertext");
    return { wrapped: Buffer.from(res.CiphertextBlob), kekId: this.currentKekId };
  }

  async unwrapKey(wrapped: Buffer, kekId: string, context: EncryptionContext) {
    if (!kekId.startsWith("aws-kms:")) throw new VaultError(`KEK ${kekId} is not an AWS KMS key`);
    const keyId = kekId.slice("aws-kms:".length);
    let res: Awaited<ReturnType<KmsLike["send"]>>;
    try {
      res = await this.client.send(
        new DecryptCommand({ CiphertextBlob: wrapped, KeyId: keyId, EncryptionContext: { ...context } }),
      );
    } catch (e) {
      throw new VaultError(`KMS Decrypt failed: ${(e as Error).name}`);
    }
    if (!res.Plaintext) throw new VaultError("KMS Decrypt returned no plaintext");
    return Buffer.from(res.Plaintext);
  }
}
