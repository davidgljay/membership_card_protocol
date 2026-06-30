/**
 * Opt-in SecretsBackend (strategic-plan.md §Secret Storage). Calls AWS KMS
 * Encrypt/Decrypt to wrap/unwrap the per-account DEK. Selected via
 * SECRETS_BACKEND=kms, independent of which Nitro preset is deployed.
 *
 * Trade-off vs. WebCryptoBackend: an AWS dependency, in exchange for a
 * logged, IAM-gated decrypt call (CloudTrail) kept in a separate credential
 * domain from the application secret.
 */

import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms';
import type { SecretsBackend } from './backend.js';

export class KmsBackend implements SecretsBackend {
  private readonly client: KMSClient;
  private readonly keyId: string;

  constructor(keyId: string, region?: string, client?: KMSClient) {
    this.keyId = keyId;
    this.client = client ?? new KMSClient(region ? { region } : {});
  }

  async wrapDek(dek: Buffer): Promise<string> {
    const result = await this.client.send(
      new EncryptCommand({ KeyId: this.keyId, Plaintext: dek })
    );
    if (!result.CiphertextBlob) {
      throw new Error('KmsBackend: Encrypt returned no CiphertextBlob.');
    }
    return Buffer.from(result.CiphertextBlob).toString('base64url');
  }

  async unwrapDek(dekEnc: string): Promise<Buffer> {
    const ciphertextBlob = Buffer.from(dekEnc, 'base64url');
    const result = await this.client.send(
      new DecryptCommand({ KeyId: this.keyId, CiphertextBlob: ciphertextBlob })
    );
    if (!result.Plaintext) {
      throw new Error('KmsBackend: Decrypt returned no Plaintext.');
    }
    return Buffer.from(result.Plaintext);
  }
}
