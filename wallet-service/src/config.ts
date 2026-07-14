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
  /** Bearer token gating the operator-facing /admin/* endpoints (strategic-plan.md §Goal 5: operational transparency). Not for end users or peers. */
  ADMIN_API_KEY: string;
  /** Arbitrum One JSON-RPC endpoint — used read-only to resolve subcard_hash -> SubCardEntry (sub_card_doc_cid) when verifying signed UUID-registration envelopes (notification_relay.md v0.8 §POST .../uuids). Same registry press/ writes to; wallet-service never submits transactions. */
  ARBITRUM_RPC_URL: string;
  /** Arbitrum One registry contract address (same contract press/ writes RegisterSubCard/SubCardEntry to — see specs/subcards.md §Step 5, specs/registry_contract.md). */
  REGISTRY_CONTRACT_ADDRESS: string;
  /** IPFS gateway base URL used to fetch SubCardDocument by sub_card_doc_cid. Defaults to the same Filebase gateway press/ uses (documents are pinned there), but any IPFS gateway serving the same CID works. */
  IPFS_GATEWAY_URL: string;
  /** The Matrix homeserver's own domain name (matrix-implementation-plan.md §Phase 2), used in shadow-account derivation (src/matrix/account-id.ts) and join-attestation verification. Same value the `synapse` container's MATRIX_SERVER_NAME env var carries — see docker-compose.yml. */
  MATRIX_SERVER_NAME: string;
  /** Base URL wallet-service uses to reach Synapse's Client-Server API as the Application Service (Phase 4 Step 15b/15c) — the `synapse` service's internal docker-compose hostname:port (matrix/homeserver.yaml.template's client listener, port 8008), not a publicly exposed address. */
  MATRIX_SYNAPSE_URL: string;
  /** Matrix user ID of the dedicated enforcement/moderation account the Synapse policy module's revocation watcher uses as `sender` for force-part (ModuleApi.update_room_membership) — see .env.example's comment. Every card-gated room created by POST /matrix/rooms (Phase 4 Step 16) must grant this account at least kick-level power in that room's m.room.power_levels state, or future force-parts in that room fail with a permission error. */
  MATRIX_ENFORCEMENT_USER_ID: string;
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
    ADMIN_API_KEY: requireEnv('ADMIN_API_KEY'),
    ARBITRUM_RPC_URL: requireEnv('ARBITRUM_RPC_URL'),
    REGISTRY_CONTRACT_ADDRESS: requireEnv('REGISTRY_CONTRACT_ADDRESS'),
    IPFS_GATEWAY_URL: optionalEnv('IPFS_GATEWAY_URL', 'https://ipfs.filebase.io'),
    MATRIX_SERVER_NAME: optionalEnv('MATRIX_SERVER_NAME', 'matrix.internal'),
    MATRIX_SYNAPSE_URL: optionalEnv('MATRIX_SYNAPSE_URL', 'http://synapse:8008'),
    MATRIX_ENFORCEMENT_USER_ID: optionalEnv('MATRIX_ENFORCEMENT_USER_ID', '@matrix-policy-bot:matrix.internal'),
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
