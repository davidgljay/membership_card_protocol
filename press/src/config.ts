/**
 * Validates all required environment variables at startup.
 * Call once before the server accepts traffic; exits with a diagnostic message on failure.
 */

export interface PressConfig {
  PRESS_CARD_CID: string;
  PRESS_POLICY_CIDS: string[];
  PRESS_MLDSA44_PRIVATE_KEY: Uint8Array;
  /**
   * secp256r1 private key (hex) registered in PressAuthorizations on-chain.
   * Used exclusively for signing press payloads. Does NOT pay gas.
   */
  PRESS_SECP256R1_PRIVATE_KEY: string;
  /**
   * Separate Ethereum wallet private key (hex) that holds ETH and pays gas
   * for all on-chain transactions. Never used for press payload signing.
   * The press's on-chain identity (PressAuthorizations key) comes from
   * PRESS_SECP256R1_PRIVATE_KEY; msg.sender comes from this key.
   */
  PRESS_GAS_WALLET_PRIVATE_KEY: string;
  /**
   * X25519 HPKE private key (client-sdk implementation plan Step 1.4d),
   * used by src/ohttp-gateway.ts to decapsulate/encapsulate the six
   * oblivious-relay-routed endpoints. Raw 32-byte key, base64url-encoded,
   * following the same environment-variable-sourced convention as
   * PRESS_MLDSA44_PRIVATE_KEY / PRESS_SECP256R1_PRIVATE_KEY rather than
   * inventing new secret-handling machinery.
   */
  PRESS_OHTTP_PRIVATE_KEY: Uint8Array;
  ARBITRUM_RPC_URL: string;
  /**
   * Chain ID startup.ts's ARBITRUM_RPC_URL check expects. Defaults to
   * Arbitrum One (42161) — production's only intended network.
   * `src/chain/{registry,gas}.ts` now derive their viem `chain` object from
   * this value (Sepolia when it's 421614, mainnet otherwise) — previously
   * both hardcoded viem's `arbitrum` (mainnet) chain object regardless,
   * which silently broke on-chain **writes** against Sepolia
   * ("Missing or invalid parameters" from `eth_sendRawTransaction`, since
   * the signed tx's chain ID didn't match the RPC endpoint's — confirmed
   * running integration_tests' write path for real). Reads were unaffected
   * (no chain ID on `eth_call`), which is why this stayed hidden until a
   * write was actually exercised. `server/tasks/reconcile-cids.ts` still
   * hardcodes `arbitrum` — not fixed here, out of scope for the write path
   * this amendment covers.
   */
  EXPECTED_CHAIN_ID: number;
  /** Logic contract — upgradeable, all write operations. */
  REGISTRY_CONTRACT_ADDRESS: string;
  /**
   * Storage contract — the stable protocol identifier (`registry_contract.md
   * §1`: "its address is the stable protocol identifier", never changes
   * across logic upgrades). All reads go here rather than through the
   * logic contract: some reads (getSubCardEntry, getOpenOfferCount) exist
   * only on storage, not re-exposed by logic at all, and reading through
   * logic would silently break after every logic upgrade even for the
   * reads logic does mirror.
   */
  STORAGE_CONTRACT_ADDRESS: string;
  /**
   * Which IpfsPinningProvider implementation to construct (src/ipfs/index.ts).
   * Defaults to 'filebase' — the production pinning vendor — so existing
   * deployments need no env changes. 'kubo' talks to a local Kubo node's
   * HTTP API directly (integration testing); 'mock' is in-memory only.
   */
  IPFS_PROVIDER: 'filebase' | 'kubo' | 'mock';
  FILEBASE_KEY: string;
  FILEBASE_SECRET: string;
  FILEBASE_GATEWAY_URL: string;
  FILEBASE_ENDPOINT: string;
  FILEBASE_REGION: string;
  FILEBASE_BUCKET: string;
  KUBO_API_URL: string;
  KUBO_GATEWAY_URL: string;
  /**
   * Redis connection URL for the `redis` KV storage driver
   * (nitro.config.ts) — only consumed there, and only on the
   * node-server/aws-lambda presets. The default cloudflare-module preset
   * uses a native `cloudflare-kv-binding` (PRESS_KV) instead; ioredis
   * (which the `redis` driver pulls in) can't run under Workers'
   * nodejs_compat. Not read anywhere in application code, only
   * build-time by nitro.config.ts's raw `process.env` access — kept here
   * only so it's documented as a real config value, not because
   * `loadConfig()`'s caller uses it.
   */
  EXTERNAL_KV_URL: string;
  PORT: number;
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';
  MAX_BATCH_SIZE: number;
  STALENESS_WINDOW_SECONDS: number;
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (val === undefined || val === '') {
    console.error(`Press startup error: required environment variable ${name} is missing or empty.`);
    process.exit(1);
  }
  return val;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

// ML-DSA-44 private key: 2560 bytes
const MLDSA44_PRIVATE_KEY_BYTES = 2560;

function decodeBase64urlKey(name: string, expectedBytes: number): Uint8Array {
  const raw = requireEnv(name);
  let decoded: Uint8Array;
  try {
    const binary = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    decoded = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      decoded[i] = binary.charCodeAt(i);
    }
  } catch {
    console.error(`Press startup error: ${name} is not valid base64url.`);
    process.exit(1);
  }
  if (decoded.length !== expectedBytes) {
    console.error(
      `Press startup error: ${name} decoded to ${decoded.length} bytes, expected ${expectedBytes}.`
    );
    process.exit(1);
  }
  return decoded;
}

function validateLogLevel(raw: string): 'debug' | 'info' | 'warn' | 'error' {
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  console.error(
    `Press startup error: LOG_LEVEL must be one of debug, info, warn, error (got "${raw}").`
  );
  process.exit(1);
}

function validateIpfsProvider(raw: string): 'filebase' | 'kubo' | 'mock' {
  if (raw === 'filebase' || raw === 'kubo' || raw === 'mock') return raw;
  console.error(
    `Press startup error: IPFS_PROVIDER must be one of filebase, kubo, mock (got "${raw}").`
  );
  process.exit(1);
}

export function loadConfig(): PressConfig {
  const PRESS_CARD_CID = requireEnv('PRESS_CARD_CID');
  const PRESS_POLICY_CIDS_RAW = requireEnv('PRESS_POLICY_CIDS');
  const PRESS_POLICY_CIDS = PRESS_POLICY_CIDS_RAW.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (PRESS_POLICY_CIDS.length === 0) {
    console.error(
      'Press startup error: PRESS_POLICY_CIDS must contain at least one CID.'
    );
    process.exit(1);
  }

  const PRESS_MLDSA44_PRIVATE_KEY = decodeBase64urlKey(
    'PRESS_MLDSA44_PRIVATE_KEY',
    MLDSA44_PRIVATE_KEY_BYTES
  );

  const PRESS_SECP256R1_PRIVATE_KEY = requireEnv('PRESS_SECP256R1_PRIVATE_KEY');
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(PRESS_SECP256R1_PRIVATE_KEY)) {
    console.error(
      'Press startup error: PRESS_SECP256R1_PRIVATE_KEY must be a 32-byte hex string (64 hex chars, with or without 0x prefix).'
    );
    process.exit(1);
  }

  const PRESS_GAS_WALLET_PRIVATE_KEY = requireEnv('PRESS_GAS_WALLET_PRIVATE_KEY');
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(PRESS_GAS_WALLET_PRIVATE_KEY)) {
    console.error(
      'Press startup error: PRESS_GAS_WALLET_PRIVATE_KEY must be a 32-byte hex string (64 hex chars, with or without 0x prefix).'
    );
    process.exit(1);
  }

  const PRESS_OHTTP_PRIVATE_KEY = decodeBase64urlKey('PRESS_OHTTP_PRIVATE_KEY', 32);

  const ARBITRUM_RPC_URL = requireEnv('ARBITRUM_RPC_URL');
  const EXPECTED_CHAIN_ID = parseInt(optionalEnv('EXPECTED_CHAIN_ID', '42161'), 10);
  const REGISTRY_CONTRACT_ADDRESS = requireEnv('REGISTRY_CONTRACT_ADDRESS');
  const STORAGE_CONTRACT_ADDRESS = requireEnv('STORAGE_CONTRACT_ADDRESS');

  const IPFS_PROVIDER = validateIpfsProvider(optionalEnv('IPFS_PROVIDER', 'filebase'));

  // Filebase vars are only required when they're actually the active
  // provider — 'kubo'/'mock' environments (e.g. integration_tests) don't
  // need Filebase credentials at all.
  const FILEBASE_KEY = IPFS_PROVIDER === 'filebase' ? requireEnv('FILEBASE_KEY') : optionalEnv('FILEBASE_KEY', '');
  const FILEBASE_SECRET = IPFS_PROVIDER === 'filebase' ? requireEnv('FILEBASE_SECRET') : optionalEnv('FILEBASE_SECRET', '');
  const FILEBASE_GATEWAY_URL = optionalEnv('FILEBASE_GATEWAY_URL', 'https://ipfs.filebase.io');
  const FILEBASE_ENDPOINT = optionalEnv('FILEBASE_ENDPOINT', 'https://s3.filebase.com');
  const FILEBASE_REGION = optionalEnv('FILEBASE_REGION', 'us-east-1');
  const FILEBASE_BUCKET = optionalEnv('FILEBASE_BUCKET', 'membership_card_protocol');

  const KUBO_API_URL = IPFS_PROVIDER === 'kubo' ? requireEnv('KUBO_API_URL') : optionalEnv('KUBO_API_URL', '');
  const KUBO_GATEWAY_URL = IPFS_PROVIDER === 'kubo' ? requireEnv('KUBO_GATEWAY_URL') : optionalEnv('KUBO_GATEWAY_URL', '');

  // Optional: only meaningful on the node-server/aws-lambda presets — see
  // this field's doc comment above.
  const EXTERNAL_KV_URL = optionalEnv('EXTERNAL_KV_URL', '');

  const PORT = parseInt(optionalEnv('PORT', '3000'), 10);
  const LOG_LEVEL = validateLogLevel(optionalEnv('LOG_LEVEL', 'info'));
  const MAX_BATCH_SIZE = parseInt(optionalEnv('MAX_BATCH_SIZE', '100'), 10);
  const STALENESS_WINDOW_SECONDS = parseInt(
    optionalEnv('STALENESS_WINDOW_SECONDS', '300'),
    10
  );

  return {
    PRESS_CARD_CID,
    PRESS_POLICY_CIDS,
    PRESS_MLDSA44_PRIVATE_KEY,
    PRESS_SECP256R1_PRIVATE_KEY,
    PRESS_GAS_WALLET_PRIVATE_KEY,
    PRESS_OHTTP_PRIVATE_KEY,
    ARBITRUM_RPC_URL,
    EXPECTED_CHAIN_ID,
    REGISTRY_CONTRACT_ADDRESS,
    STORAGE_CONTRACT_ADDRESS,
    IPFS_PROVIDER,
    FILEBASE_KEY,
    FILEBASE_SECRET,
    FILEBASE_GATEWAY_URL,
    FILEBASE_ENDPOINT,
    FILEBASE_REGION,
    FILEBASE_BUCKET,
    KUBO_API_URL,
    KUBO_GATEWAY_URL,
    EXTERNAL_KV_URL,
    PORT,
    LOG_LEVEL,
    MAX_BATCH_SIZE,
    STALENESS_WINDOW_SECONDS,
  };
}
