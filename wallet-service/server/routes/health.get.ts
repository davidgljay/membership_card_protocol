/**
 * GET /health — implementation-plan.md §Step 1.5.
 * Checks Postgres reachability and exercises a full encrypt/decrypt
 * round-trip against whichever SecretsBackend is configured.
 */

import { loadConfig } from '../../src/config.js';
import { checkDatabaseHealth } from '../db/client.js';
import { createSecretsService } from '../../src/secrets/index.js';

async function checkSecretsHealth(): Promise<boolean> {
  try {
    const config = loadConfig();
    const service = createSecretsService(config);
    const probe = Buffer.from('health-check-probe-32-bytes!!!!!');
    const { ciphertext, dekEnc } = await service.encryptSecret(probe);
    const decrypted = await service.decryptSecret(ciphertext, dekEnc);
    return decrypted.equals(probe);
  } catch {
    return false;
  }
}

export default defineEventHandler(async (event) => {
  const [postgresOk, secretsOk] = await Promise.all([checkDatabaseHealth(), checkSecretsHealth()]);

  const allOk = postgresOk && secretsOk;
  if (!allOk) {
    setResponseStatus(event, 503);
  }

  return {
    status: allOk ? 'ok' : 'degraded',
    postgres: postgresOk ? 'ok' : 'error',
    secrets: secretsOk ? 'ok' : 'error',
  };
});
