import { AwsKmsKeyProvider } from "./aws-kms";
import { type KeyProvider, LocalKeyProvider, VaultError } from "./keys";

/** BRIO_KMS_PROVIDER=local (BRIO_VAULT_LOCAL_KEK, comma-separated, current first) or aws (BRIO_AWS_KMS_KEY_ID). */
export function keyProviderFromEnv(env: NodeJS.ProcessEnv = process.env): KeyProvider {
  const kind = env.BRIO_KMS_PROVIDER ?? "local";
  if (kind === "local") {
    if (!env.BRIO_VAULT_LOCAL_KEK)
      throw new VaultError("BRIO_VAULT_LOCAL_KEK is not set (openssl rand -base64 32)");
    return LocalKeyProvider.fromBase64(env.BRIO_VAULT_LOCAL_KEK);
  }
  if (kind === "aws") return new AwsKmsKeyProvider(env.BRIO_AWS_KMS_KEY_ID ?? "");
  throw new VaultError(`unknown BRIO_KMS_PROVIDER "${kind}" (use local or aws)`);
}
