/**
 * Configuration for DNS governance scripts.
 *
 * Key separation:
 *
 *   DNS_SCRIPT_PRIVATE_KEY    — secp256r1 key in the DnsGovernanceBody keyset.
 *                               Signs governance payloads for routine, deterministic script
 *                               operations (RegisterDomain, DeregisterDomain, ClearDomainEntries,
 *                               RemovePolicyAddress on fraud, GovernanceSetPolicyAddress to
 *                               clear stale entries). 1-of-1 quorum suffices for these.
 *
 *   DNS_SCRIPT_GAS_WALLET_KEY — Separate Ethereum wallet holding ETH for gas on governance
 *                               transactions. Never used for payload signing.
 *
 *   PRESS_URL                 — Base URL of the authorized press that issues and updates
 *                               domain admin cards on behalf of the governance authority.
 *                               The press handles card document IPFS pinning and RegisterCard /
 *                               UpdateCardHead on-chain calls. The governance scripts treat
 *                               the press as a black-box HTTP service.
 *
 * Board-level operations (FlagDomainFraudRisk with suspension, manual
 * GovernanceSetPolicyAddress for rollback, SetDnsGovernancePolicyAddress) require M-of-N
 * human operator signatures and are NOT submitted by these scripts. Scripts generate
 * unsigned payloads and log them for human operators to sign and submit.
 */

import { randomBytes } from 'crypto';
import type { Hex } from 'viem';
import { createIpfsReader, type IpfsReader } from './ipfs.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GovScriptConfig {
  // ── Script signing key (DnsGovernanceBody, 1-of-1 routine ops) ──────────
  scriptPrivateKey: Hex;
  /**
   * On-chain bytes32 address of the script key: keccak256(secp256r1_pubkey x||y).
   * Pre-computed and set as DNS_SCRIPT_ADDRESS. Derive with:
   *   node -e "const {p256}=require('@noble/curves/nist.js');
   *     const {keccak_256}=require('@noble/hashes/sha3.js');
   *     const k=Buffer.from('<key_hex>','hex');
   *     const pub=p256.getPublicKey(k,false).slice(1);
   *     console.log('0x'+Buffer.from(keccak_256(pub)).toString('hex'));"
   */
  scriptAddress: Hex;

  // ── Script gas wallet (pays ETH for governance transactions) ─────────────
  scriptGasWalletKey: Hex;

  // ── Press (card issuance and revocation via HTTP) ─────────────────────────
  /**
   * Base URL of the authorized press. The governance scripts POST to this
   * press to issue domain admin cards and submit 9xx revocations.
   * The press holds its own signing keys and Filebase credentials.
   */
  pressUrl: string;

  // ── Chain ─────────────────────────────────────────────────────────────────
  rpcUrl: string;
  /** Storage contract address (stable protocol identifier). */
  registryAddress: Hex;
  /** Logic contract address (for event subscriptions and write calls). */
  logicContractAddress: Hex;
  /** DnsGovernancePolicyAddress — policy under which domain admin cards are issued. */
  dnsPolicyAddress: Hex;
  /**
   * The governance authority's own card address. Listed as auditor on all
   * domain admin cards and inherited by all sub-cards derived from them.
   */
  authorityCardAddress: Hex;

  // ── IPFS (reads only — writes go through the press) ─────────────────────
  ipfsGatewayUrl: string;

  // ── Script C only ─────────────────────────────────────────────────────────
  brandNameListUrl: string;
  eventCursorStore: string;
  slaHours: number;
}

// ---------------------------------------------------------------------------
// Nonce generation
// ---------------------------------------------------------------------------

/**
 * Generate a fresh governance payload nonce: 32 random bytes encoded as base64url.
 * Governance payloads embed this as `"nonce": "<base64url>"`. The on-chain nonce store
 * uses keccak256(nonce_raw_bytes) as the key to prevent reuse (E-07G).
 * Nonces are generated per-call and never persisted.
 */
export function generateNonce(): string {
  return randomBytes(32).toString('base64url');
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

function req(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`[dns-gov] Missing required env var: ${name}`); process.exit(1); }
  return v!;
}

function opt(name: string, def: string): string {
  return process.env[name] ?? def;
}

function requireHex(name: string): Hex {
  const v = req(name);
  const hex = (v.startsWith('0x') ? v : `0x${v}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    console.error(`[dns-gov] ${name} must be a 32-byte hex string (64 hex chars)`);
    process.exit(1);
  }
  return hex;
}

export function loadConfig(): GovScriptConfig {
  return {
    scriptPrivateKey:     requireHex('DNS_SCRIPT_PRIVATE_KEY'),
    scriptAddress:        requireHex('DNS_SCRIPT_ADDRESS'),
    scriptGasWalletKey:   requireHex('DNS_SCRIPT_GAS_WALLET_KEY'),
    pressUrl:             req('PRESS_URL').replace(/\/$/, ''),
    rpcUrl:               req('RPC_URL'),
    registryAddress:      requireHex('REGISTRY_ADDRESS'),
    logicContractAddress: requireHex('LOGIC_CONTRACT_ADDRESS'),
    dnsPolicyAddress:     requireHex('DNS_GOV_POLICY_ADDRESS'),
    authorityCardAddress: requireHex('AUTHORITY_CARD_ADDRESS'),
    ipfsGatewayUrl:       opt('IPFS_GATEWAY_URL', 'https://ipfs.filebase.io'),
    brandNameListUrl:     req('BRAND_NAME_LIST_URL'),
    eventCursorStore:     opt('EVENT_CURSOR_STORE', '/tmp/policy-verifier-cursor.json'),
    slaHours:             parseInt(opt('SLA_HOURS', '24'), 10),
  };
}

/** Build an IpfsReader from loaded config. */
export function createIpfsClient(config: GovScriptConfig): IpfsReader {
  return createIpfsReader(config.ipfsGatewayUrl);
}
