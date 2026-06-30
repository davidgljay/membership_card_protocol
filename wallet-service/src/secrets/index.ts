import type { WalletServiceConfig } from '../config.js';
import { WebCryptoBackend } from './webcrypto-backend.js';
import { KmsBackend } from './kms-backend.js';
import { SecretsService } from './secrets-service.js';

export { SecretsService } from './secrets-service.js';
export type { SecretsBackend } from './backend.js';
export type { EncryptedSecret } from './secrets-service.js';
export { WebCryptoBackend } from './webcrypto-backend.js';
export { KmsBackend } from './kms-backend.js';

export function createSecretsService(config: WalletServiceConfig): SecretsService {
  if (config.SECRETS_BACKEND === 'kms') {
    if (!config.KMS_KEY_ID) {
      throw new Error('createSecretsService: KMS_KEY_ID is required when SECRETS_BACKEND=kms.');
    }
    return new SecretsService(new KmsBackend(config.KMS_KEY_ID, config.AWS_REGION));
  }
  if (!config.WEBCRYPTO_MASTER_KEY) {
    throw new Error('createSecretsService: WEBCRYPTO_MASTER_KEY is required when SECRETS_BACKEND=webcrypto.');
  }
  return new SecretsService(new WebCryptoBackend(config.WEBCRYPTO_MASTER_KEY));
}
