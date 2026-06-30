/**
 * Validates all required environment variables at startup.
 * Call once before the server accepts traffic; exits with a diagnostic message on failure.
 */

export interface WalletServiceConfig {
  DATABASE_URL: string;
  /** Backend selection for service_secret envelope encryption (strategic-plan.md §Secret Storage). */
  SECRETS_BACKEND: 'webcrypto' | 'kms';
  /** base64url AES-256 master key, used only when SECRETS_BACKEND=webcrypto. */
  WEBCRYPTO_MASTER_KEY: string | undefined;
  /** AWS KMS key ARN, used only when SECRETS_BACKEND=kms. */
  KMS_KEY_ID: string | undefined;
  AWS_REGION: string | undefined;
  /** Shared HMAC key used to validate registration tokens issued by the card acceptance flow. */
  REGISTRATION_TOKEN_SECRET: string;
  /** HMAC key used to sign/verify session tokens (Step 1.4). Distinct from REGISTRATION_TOKEN_SECRET — separate credential domains. */
  SESSION_TOKEN_SECRET: string;
  PORT: number;
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (val === undefined || val === '') {
    console.error(`Wallet service startup error: required environment variable ${name} is missing or empty.`);
    process.exit(1);
  }
  return val;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

let cached: WalletServiceConfig | null = null;

export function loadConfig(): WalletServiceConfig {
  if (cached) return cached;

  const secretsBackend = optionalEnv('SECRETS_BACKEND', 'webcrypto');
  if (secretsBackend !== 'webcrypto' && secretsBackend !== 'kms') {
    console.error(`Wallet service startup error: SECRETS_BACKEND must be 'webcrypto' or 'kms', got '${secretsBackend}'.`);
    process.exit(1);
  }

  const config: WalletServiceConfig = {
    DATABASE_URL: requireEnv('DATABASE_URL'),
    SECRETS_BACKEND: secretsBackend,
    WEBCRYPTO_MASTER_KEY: process.env['WEBCRYPTO_MASTER_KEY'],
    KMS_KEY_ID: process.env['KMS_KEY_ID'],
    AWS_REGION: process.env['AWS_REGION'],
    REGISTRATION_TOKEN_SECRET: requireEnv('REGISTRATION_TOKEN_SECRET'),
    SESSION_TOKEN_SECRET: requireEnv('SESSION_TOKEN_SECRET'),
    PORT: Number(optionalEnv('PORT', '3000')),
    LOG_LEVEL: optionalEnv('LOG_LEVEL', 'info') as WalletServiceConfig['LOG_LEVEL'],
  };

  if (secretsBackend === 'webcrypto' && !config.WEBCRYPTO_MASTER_KEY) {
    console.error('Wallet service startup error: WEBCRYPTO_MASTER_KEY is required when SECRETS_BACKEND=webcrypto.');
    process.exit(1);
  }
  if (secretsBackend === 'kms' && !config.KMS_KEY_ID) {
    console.error('Wallet service startup error: KMS_KEY_ID is required when SECRETS_BACKEND=kms.');
    process.exit(1);
  }

  cached = config;
  return config;
}

/** Test-only: clears the cached config so tests can reload with different env vars. */
export function resetConfigCache(): void {
  cached = null;
}
