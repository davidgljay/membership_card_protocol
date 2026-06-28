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
  ARBITRUM_RPC_URL: string;
  REGISTRY_CONTRACT_ADDRESS: string;
  FILEBASE_KEY: string;
  FILEBASE_SECRET: string;
  FILEBASE_GATEWAY_URL: string;
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

  const ARBITRUM_RPC_URL = requireEnv('ARBITRUM_RPC_URL');
  const REGISTRY_CONTRACT_ADDRESS = requireEnv('REGISTRY_CONTRACT_ADDRESS');
  const FILEBASE_KEY = requireEnv('FILEBASE_KEY');
  const FILEBASE_SECRET = requireEnv('FILEBASE_SECRET');
  // Bucket is hardcoded to 'membership_card_protocol' in ipfs/client.ts.
  const FILEBASE_GATEWAY_URL = optionalEnv(
    'FILEBASE_GATEWAY_URL',
    'https://ipfs.filebase.io'
  );
  const EXTERNAL_KV_URL = requireEnv('EXTERNAL_KV_URL');

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
    ARBITRUM_RPC_URL,
    REGISTRY_CONTRACT_ADDRESS,
    FILEBASE_KEY,
    FILEBASE_SECRET,
    FILEBASE_GATEWAY_URL,
    EXTERNAL_KV_URL,
    PORT,
    LOG_LEVEL,
    MAX_BATCH_SIZE,
    STALENESS_WINDOW_SECONDS,
  };
}
