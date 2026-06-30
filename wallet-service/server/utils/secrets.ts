import { loadConfig } from '../../src/config.js';
import { createSecretsService, type SecretsService } from '../../src/secrets/index.js';

let cached: SecretsService | null = null;

export function getSecretsService(): SecretsService {
  if (!cached) {
    cached = createSecretsService(loadConfig());
  }
  return cached;
}
