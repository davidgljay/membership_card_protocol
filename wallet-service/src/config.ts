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
  /** HMAC key used to sign/verify session tokens (Step 1.4). */
  SESSION_TOKEN_SECRET: string;
  /** KV backend selection (Step 1.4 design, resolved here): 'cloudflare-kv' requires a real Workers KV binding (production Cloudflare deploys only); 'postgres' is the documented fallback and the default everywhere else, including local dev and CI. */
  KV_BACKEND: 'cloudflare-kv' | 'postgres';
  /** WebAuthn relying party id (e.g. "wallet.example.com") — used to verify passkey login assertions (Step 2.1). */
  WEBAUTHN_RP_ID: string;
  /** WebAuthn expected origin (e.g. "https://wallet.example.com") — used to verify passkey login assertions (Step 2.1). */
  WEBAUTHN_ORIGIN: string;
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
    SESSION_TOKEN_SECRET: requireEnv('SESSION_TOKEN_SECRET'),
    KV_BACKEND: optionalEnv('KV_BACKEND', 'postgres') as WalletServiceConfig['KV_BACKEND'],
    WEBAUTHN_RP_ID: requireEnv('WEBAUTHN_RP_ID'),
    WEBAUTHN_ORIGIN: requireEnv('WEBAUTHN_ORIGIN'),
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
  if (config.KV_BACKEND !== 'cloudflare-kv' && config.KV_BACKEND !== 'postgres') {
    console.error(`Wallet service startup error: KV_BACKEND must be 'cloudflare-kv' or 'postgres', got '${config.KV_BACKEND}'.`);
    process.exit(1);
  }

  cached = config;
  return config;
}

/** Test-only: clears the cached config so tests can reload with different env vars. */
export function resetConfigCache(): void {
  cached = null;
}
