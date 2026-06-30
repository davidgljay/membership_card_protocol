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
  /** SendGrid API key (Step 3.3). If unset, email notifications fall back to a console-logging provider — fine for local dev, not for production. */
  SENDGRID_API_KEY: string | undefined;
  SENDGRID_FROM_EMAIL: string | undefined;
  /** Twilio credentials (Step 3.3). If unset, SMS notifications fall back to a console-logging provider. */
  TWILIO_ACCOUNT_SID: string | undefined;
  TWILIO_AUTH_TOKEN: string | undefined;
  TWILIO_FROM_NUMBER: string | undefined;
  /** This instance's own wallet service identity (Step 4.0/4.1) — the mutable pointer of its wallet service card, used as `wallet_service_id` in CardBindingAnnouncements and federation messages. */
  WALLET_SERVICE_ID: string;
  /** Base HTTPS URL peers should use to reach this instance — included in announcements so peers can route to it. */
  WALLET_SERVICE_ENDPOINT: string;
  /** ML-DSA-44 secret key (base64url) signing this instance's announcements and federation messages as the 'wallet_service' role. */
  WALLET_SERVICE_PRIVATE_KEY: string;
  /** Static peer list (Step 4.0, message_routing.md §Wallet Service Registry §Peer List) — JSON array of { wallet_service_id, endpoint, pubkey_hash }. Empty by default (single-instance per OQ-WS-5); federation is opt-in via config. */
  PEER_LIST: PeerConfig[];
  /** Base URL for the relay's POST /deliver/{uuid} and message endpoints (Step 4.4). */
  RELAY_BASE_URL: string;
}

export interface PeerConfig {
  wallet_service_id: string;
  endpoint: string;
  pubkey_hash: string;
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

function parsePeerList(raw: string): PeerConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('Wallet service startup error: PEER_LIST is not valid JSON.');
    process.exit(1);
  }
  if (!Array.isArray(parsed)) {
    console.error('Wallet service startup error: PEER_LIST must be a JSON array.');
    process.exit(1);
  }
  for (const entry of parsed) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof entry.wallet_service_id !== 'string' ||
      typeof entry.endpoint !== 'string' ||
      typeof entry.pubkey_hash !== 'string'
    ) {
      console.error(
        'Wallet service startup error: each PEER_LIST entry must have wallet_service_id, endpoint, and pubkey_hash strings.'
      );
      process.exit(1);
    }
  }
  return parsed as PeerConfig[];
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
    SENDGRID_API_KEY: process.env['SENDGRID_API_KEY'],
    SENDGRID_FROM_EMAIL: process.env['SENDGRID_FROM_EMAIL'],
    TWILIO_ACCOUNT_SID: process.env['TWILIO_ACCOUNT_SID'],
    TWILIO_AUTH_TOKEN: process.env['TWILIO_AUTH_TOKEN'],
    TWILIO_FROM_NUMBER: process.env['TWILIO_FROM_NUMBER'],
    WALLET_SERVICE_ID: requireEnv('WALLET_SERVICE_ID'),
    WALLET_SERVICE_ENDPOINT: requireEnv('WALLET_SERVICE_ENDPOINT'),
    WALLET_SERVICE_PRIVATE_KEY: requireEnv('WALLET_SERVICE_PRIVATE_KEY'),
    PEER_LIST: parsePeerList(optionalEnv('PEER_LIST', '[]')),
    RELAY_BASE_URL: requireEnv('RELAY_BASE_URL'),
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
