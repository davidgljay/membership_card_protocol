/**
 * DNS governance registry client.
 *
 * Handles on-chain reads and script-authorized governance writes.
 * Does NOT implement press operations — card issuance and revocation
 * are delegated to an authorized press over HTTP (see PRESS_URL in config).
 *
 * Script-authorized operations (1-of-1 script key):
 *   RegisterDomain, DeregisterDomain, ClearDomainEntries, RemovePolicyAddressGov,
 *   GovernanceSetPolicyAddressAuto
 *
 * Board-only operations (M-of-N human quorum, NOT submitted here):
 *   FlagDomainFraudRisk (suspension), manual GovernanceSetPolicyAddress (rollback)
 *   → scripts call generateEscalationPayload() which logs the unsigned payload for operators.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  keccak256 as viemKeccak256,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';
import { p256 } from '@noble/curves/nist.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import type { GovScriptConfig } from './config.js';
import { generateNonce } from './config.js';

// ---------------------------------------------------------------------------
// ABI — DNS functions on logic contract + shared reads
// ---------------------------------------------------------------------------
// Fixed 2026-07-23 — this ABI previously declared PascalCase function names
// and typed `Vec<u8>`/`Vec<Vec<u8>>` params/returns as Solidity `bytes`/
// `bytes[]`. Stylus SDK 0.8 actually dispatches on the camelCase-converted
// selector (Rust snake_case -> camelCase) and maps `Vec<u8>`/`Vec<Vec<u8>>`
// to `uint8[]`/`uint8[][]`, not `bytes`/`bytes[]` — confirmed against
// `cargo stylus export-abi`'s real output for this exact logic contract
// (run 2026-07-23) and against `press/src/chain/registry.ts`'s own
// long-working camelCase ABI, which hit and fixed the identical casing/
// type bug independently, earlier in the same integration-testing effort
// this fix is also part of (see that file's own "ABI note" comment).
// Every write method below would previously have encoded a call to a
// non-existent selector (a silent revert on submission); every multi-value
// read would have mis-decoded.
//
// `getCardEntry`/`getGovernanceKeyset`/`getSubCardEntry`/
// `getPressAuthorization` each mix a `uint8[]` into an otherwise-scalar
// multi-value return — the same "extra 32-byte outer tuple offset" quirk
// `press/src/chain/registry.ts` already documents and works around by
// declaring the return as a single named struct/tuple rather than a plain
// comma-separated list. Applied the same fix here.
//
// **Known residual issue, NOT fixed here** (out of scope for an ABI-casing
// fix): `getSubCardEntry` does not appear anywhere in the logic contract's
// real exported ABI at all — per the same investigation that already
// established (in `press/src/chain/registry.ts`'s own comment, and
// `integration_tests/suites/extended/dns_governance_verifier.spec.ts`'s
// research) that `getSubCardEntry` exists only on the **storage** contract,
// not logic. `policy-address-verifier.ts`'s Script C calls
// `registry.getSubCardEntry(...)`, which will therefore still fail against
// `logicAddr` even after this casing fix — fixing that needs a second,
// storage-contract-address-aware client (`GovScriptConfig` has no
// `storageContractAddress` field at all today), a real but separate
// change from what this fix addresses. Left declared here (camelCase-
// correct, for whenever that follow-up lands) but not wired to the right
// contract.
const LOGIC_ABI = parseAbi([
  // ── DNS governance write operations (script-authorized, §4.17–4.21, §4.23) ─
  'function registerDomain(uint8[] domain, bytes32 admin_card_address, uint8[] admin_secp256r1_key, uint8[] governance_payload, uint8[][] governance_sigs) external',
  'function deregisterDomain(uint8[] domain, uint8[] governance_payload, uint8[][] governance_sigs) external',
  'function removePolicyAddress(uint8[] domain, uint8[] path, bytes32 card_address, bytes32 press_address, uint8[] press_sig_payload, uint8[] press_signature, uint8[] governance_payload, uint8[][] governance_sigs) external',
  'function clearDomainEntries(uint8[] domain, uint8[][] paths, uint8[] governance_payload, uint8[][] governance_sigs) external',
  'function governanceSetPolicyAddress(uint8[] domain, uint8[] path, bytes32 policy_card_address, uint8[] governance_payload, uint8[][] governance_sigs) external',

  // ── DNS governance write operations (board-only, §4.22, §4.24) ───────────
  // These are NOT called by scripts; payloads are generated for human operators.
  'function flagDomainFraudRisk(uint8[] domain, uint8 fraud_risk, uint64 suspension_expires_at, uint8[] governance_payload, uint8[][] governance_sigs) external',
  'function setDnsGovernancePolicyAddress(bytes32 new_policy_address, uint8[] governance_payload, uint8[][] governance_sigs) external',

  // ── Read operations ───────────────────────────────────────────────────────
  'function getCardEntry(bytes32 card_address) external view returns ((uint8[] log_head_cid, bytes32 policy_address, bytes32 last_press_address, bytes32 forward_to, bool exists) r)',
  'function cardExists(bytes32 card_address) external view returns (bool)',
  'function getSubCardEntry(bytes32 sub_card_address) external view returns ((bytes32 master_card_address, uint8[] registration_log_head, uint8[] sub_card_doc_cid, bool active, uint64 registered_at, uint64 deregistered_at) r)',
  'function getDomainRegistration(uint8[] domain) external view returns (bytes32 admin_card_address, uint64 registered_at, uint8 fraud_risk, uint64 suspension_expires_at, bool exists)',
  'function getGovernanceKeyset(uint8 body_id) external view returns ((uint8[] keys_flat, uint8 key_count, uint8 quorum, uint32 version, uint8 key_scheme) r)',
  'function getPressAuthorization(bytes32 policy_address, bytes32 press_address) external view returns ((uint8[] press_public_key, bytes32 mldsa44_key_hash, uint8 key_scheme, bool active, uint64 next_sequence, uint64 authorized_at, uint64 revoked_at) r)',
  'function lookupPolicyAddress(uint8[] domain, uint8[] path) external view returns (bytes32)',
  'function getDnsAdminCardKey(bytes32 card_address) external view returns (uint8[])',
]);

// DnsGovernanceBody body_id = 2
const DNS_GOVERNANCE_BODY = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DomainEntry {
  adminCardAddress: Hex;
  registeredAt: bigint;
  fraudRisk: number;
  suspensionExpiresAt: bigint;
  exists: boolean;
}

export interface CardEntry {
  logHeadCid: Uint8Array;
  policyAddress: Hex;
  lastPressAddress: Hex;
  forwardTo: Hex;
  exists: boolean;
}

export interface SubCardEntry {
  masterCardAddress: Hex;
  registrationLogHead: Uint8Array;
  subCardDocCid: Uint8Array;
  active: boolean;
  registeredAt: bigint;
  deregisteredAt: bigint;
}

export interface PolicyAddressSetLog {
  domain: string;
  path: string;
  policyCardAddress: Hex;
  adminCardAddress: Hex;
  subCardAddress: Hex;
  pressAddress: Hex;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
}

/** Unsigned escalation payload for board operators. Logged; not submitted by scripts. */
export interface EscalationPayload {
  operation: string;
  payloadJson: string;
  payloadHash: Hex;
  instructions: string;
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

export interface DnsGovRegistryClient {
  // Reads
  getDomainRegistration(domain: string): Promise<DomainEntry>;
  getCardEntry(cardAddress: Hex): Promise<CardEntry>;
  cardExists(cardAddress: Hex): Promise<boolean>;
  getSubCardEntry(subCardAddress: Hex): Promise<SubCardEntry>;
  getDnsAdminCardKey(cardAddress: Hex): Promise<Uint8Array>;
  fetchPolicyAddressSetEvents(fromBlock: bigint, toBlock: bigint): Promise<PolicyAddressSetLog[]>;
  getLatestBlock(): Promise<bigint>;

  // Script-authorized governance writes (1-of-1 script key)
  registerDomain(domain: string, adminCardAddress: Hex, adminSecpKey: Uint8Array): Promise<Hex>;
  deregisterDomain(domain: string): Promise<Hex>;
  removePolicyAddressGov(domain: string, path: string): Promise<Hex>;
  clearDomainEntries(domain: string, paths: string[]): Promise<Hex>;
  governanceSetPolicyAddressAuto(domain: string, path: string, value: Hex): Promise<Hex>;

  // Board escalation — generates unsigned payload for human operators; does NOT submit
  generateEscalationPayload(
    operation: 'FlagDomainFraudRisk' | 'GovernanceSetPolicyAddress' | 'SetDnsGovernancePolicyAddress',
    fields: Record<string, unknown>,
  ): Promise<EscalationPayload>;
}

export function createDnsGovRegistryClient(config: GovScriptConfig): DnsGovRegistryClient {
  // Script signing account (secp256r1, for governance payload signing only)
  const scriptSignAccount = privateKeyToAccount(config.scriptPrivateKey);

  // Script gas wallet (pays ETH for governance transactions)
  const scriptGasAccount = privateKeyToAccount(config.scriptGasWalletKey);

  const publicClient: PublicClient = createPublicClient({
    chain: arbitrum,
    transport: http(config.rpcUrl),
  });

  const scriptGasClient: WalletClient = createWalletClient({
    account: scriptGasAccount,
    chain: arbitrum,
    transport: http(config.rpcUrl),
  });

  const logicAddr = config.logicContractAddress;

  // ── Governance payload construction ──────────────────────────────────────

  async function getGovVersion(): Promise<number> {
    const result = await publicClient.readContract({
      address: config.registryAddress,
      abi: LOGIC_ABI,
      functionName: 'getGovernanceKeyset',
      args: [DNS_GOVERNANCE_BODY],
    });
    const r = result as { keys_flat: readonly number[]; key_count: number; quorum: number; version: number; key_scheme: number };
    return r.version;
  }

  function toBase64url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64url');
  }

  function hexToBytes(hex: Hex): Uint8Array {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    const b = new Uint8Array(clean.length / 2);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return b;
  }

  /** Encode bytes as 0x-prefixed hex string for viem ABI `bytes` parameters. */
  function bytesToHex(bytes: Uint8Array): Hex {
    return ('0x' + Buffer.from(bytes).toString('hex')) as Hex;
  }

  /** Decode a viem `bytes` return value (0x-prefixed hex) to Uint8Array. */
  function hexBytesResult(result: unknown): Uint8Array {
    if (typeof result === 'string') return hexToBytes(result as Hex);
    return new Uint8Array(result as ArrayBuffer);
  }

  /**
   * `uint8[]` ABI parameters (Stylus's `Vec<u8>` encoding — see this file's
   * LOGIC_ABI comment) need a plain `number[]`, not a raw `Uint8Array`, for
   * viem's ABI encoder — same conversion `governanceBootstrap.ts` and
   * `dns_governance_verifier.spec.ts` already use for the identical reason.
   */
  function bytesToUint8Array(bytes: Uint8Array): number[] {
    return Array.from(bytes);
  }

  function keccak256(input: Uint8Array): Uint8Array {
    return keccak_256(input);
  }

  function canonicalize(obj: Record<string, unknown>): Uint8Array {
    // RFC 8785: keys sorted, no whitespace
    function ser(v: unknown): string {
      if (v === null) return 'null';
      if (typeof v === 'boolean') return String(v);
      if (typeof v === 'number') return JSON.stringify(v);
      if (typeof v === 'string') return JSON.stringify(v);
      if (Array.isArray(v)) return `[${v.map(ser).join(',')}]`;
      if (typeof v === 'object') {
        const keys = Object.keys(v as object).sort();
        return `{${keys.map(k => `${JSON.stringify(k)}:${ser((v as Record<string,unknown>)[k])}`).join(',')}}`;
      }
      throw new TypeError(`Cannot serialize ${typeof v}`);
    }
    return new TextEncoder().encode(ser(obj));
  }

  function secp256r1Sign(privateKeyHex: Hex, messageHash: Uint8Array): Uint8Array {
    // @noble/curves v2: sign() returns Uint8Array (compact r||s) directly.
    // secretKey must be Uint8Array, not hex string.
    const privKeyBytes = hexToBytes(privateKeyHex);
    return p256.sign(messageHash, privKeyBytes, { lowS: true, prehash: false });
  }

  async function buildGovPayload(
    op: string,
    fields: Record<string, unknown>,
  ): Promise<{ payloadBytes: Uint8Array; sig: Uint8Array }> {
    const version = await getGovVersion();
    const nonce = generateNonce();
    const payload: Record<string, unknown> = {
      op,
      ...fields,
      governance_version: version,
      nonce,
      timestamp: new Date().toISOString(),
    };
    const payloadBytes = canonicalize(payload);
    const hash = keccak256(payloadBytes);
    const sig = secp256r1Sign(config.scriptPrivateKey, hash);
    return { payloadBytes, sig };
  }

  async function submitGovTx(functionName: string, args: unknown[]): Promise<Hex> {
    const txHash = await scriptGasClient.writeContract({
      address: logicAddr,
      abi: LOGIC_ABI,
      functionName: functionName as never,
      args: args as never,
      account: scriptGasAccount,
      chain: arbitrum,
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }

  // ── Read methods ──────────────────────────────────────────────────────────

  async function getDomainRegistration(domain: string): Promise<DomainEntry> {
    const result = await publicClient.readContract({
      address: logicAddr,
      abi: LOGIC_ABI,
      functionName: 'getDomainRegistration',
      args: [bytesToUint8Array(new TextEncoder().encode(domain))],
    });
    const [admin, regAt, fr, sus, exists] = result as unknown as [Hex, bigint, number, bigint, boolean];
    return { adminCardAddress: admin, registeredAt: regAt, fraudRisk: fr, suspensionExpiresAt: sus, exists };
  }

  async function getCardEntry(cardAddress: Hex): Promise<CardEntry> {
    const result = await publicClient.readContract({
      address: logicAddr,
      abi: LOGIC_ABI,
      functionName: 'getCardEntry',
      args: [cardAddress],
    });
    const r = result as { log_head_cid: readonly number[]; policy_address: Hex; last_press_address: Hex; forward_to: Hex; exists: boolean };
    return {
      logHeadCid: new Uint8Array(r.log_head_cid),
      policyAddress: r.policy_address,
      lastPressAddress: r.last_press_address,
      forwardTo: r.forward_to,
      exists: r.exists,
    };
  }

  async function cardExists(cardAddress: Hex): Promise<boolean> {
    return publicClient.readContract({
      address: logicAddr,
      abi: LOGIC_ABI,
      functionName: 'cardExists',
      args: [cardAddress],
    }) as Promise<boolean>;
  }

  // KNOWN RESIDUAL BUG, not fixed here — see this file's LOGIC_ABI comment:
  // getSubCardEntry does not exist on the logic contract at all (confirmed
  // via `cargo stylus export-abi`; it's storage-contract-only). This call
  // will fail regardless of the casing fix below, since `logicAddr` is the
  // wrong contract — fixing that needs a storage-contract-aware client,
  // out of scope for this pass.
  async function getSubCardEntry(subCardAddress: Hex): Promise<SubCardEntry> {
    const result = await publicClient.readContract({
      address: logicAddr,
      abi: LOGIC_ABI,
      functionName: 'getSubCardEntry',
      args: [subCardAddress],
    });
    const r = result as {
      master_card_address: Hex;
      registration_log_head: readonly number[];
      sub_card_doc_cid: readonly number[];
      active: boolean;
      registered_at: bigint;
      deregistered_at: bigint;
    };
    return {
      masterCardAddress: r.master_card_address,
      registrationLogHead: new Uint8Array(r.registration_log_head),
      subCardDocCid: new Uint8Array(r.sub_card_doc_cid),
      active: r.active,
      registeredAt: r.registered_at,
      deregisteredAt: r.deregistered_at,
    };
  }

  async function getDnsAdminCardKey(cardAddress: Hex): Promise<Uint8Array> {
    const result = await publicClient.readContract({
      address: logicAddr,
      abi: LOGIC_ABI,
      functionName: 'getDnsAdminCardKey',
      args: [cardAddress],
    });
    return new Uint8Array(result as ArrayLike<number>);
  }

  async function getLatestBlock(): Promise<bigint> {
    return publicClient.getBlockNumber();
  }

  async function fetchPolicyAddressSetEvents(
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<PolicyAddressSetLog[]> {
    // PolicyAddressSet event topic: keccak256("PolicyAddressSet(bytes,bytes,bytes32,bytes32,bytes32,bytes32,uint64)")
    // Using getLogs with the logic contract address as source.
    const logs = await publicClient.getLogs({
      address: logicAddr,
      event: {
        type: 'event',
        name: 'PolicyAddressSet',
        inputs: [
          { type: 'bytes', name: 'domain', indexed: false },
          { type: 'bytes', name: 'path', indexed: false },
          { type: 'bytes32', name: 'policy_card_address', indexed: true },
          { type: 'bytes32', name: 'admin_card_address', indexed: false },
          { type: 'bytes32', name: 'sub_card_address', indexed: false },
          { type: 'bytes32', name: 'press_address', indexed: false },
          { type: 'uint64', name: 'timestamp', indexed: false },
        ],
      },
      fromBlock,
      toBlock,
    });

    return logs.map((log, i) => {
      const { domain, path, policy_card_address, admin_card_address, sub_card_address, press_address } =
        log.args as Record<string, unknown>;
      return {
        domain: new TextDecoder().decode(domain as Uint8Array),
        path: new TextDecoder().decode(path as Uint8Array),
        policyCardAddress: policy_card_address as Hex,
        adminCardAddress: admin_card_address as Hex,
        subCardAddress: sub_card_address as Hex,
        pressAddress: press_address as Hex,
        blockNumber: log.blockNumber ?? 0n,
        logIndex: log.logIndex ?? i,
        transactionHash: log.transactionHash ?? '0x',
      };
    });
  }

  // ── Script-authorized governance writes ───────────────────────────────────

  async function registerDomain(
    domain: string,
    adminCardAddress: Hex,
    adminSecpKey: Uint8Array,
  ): Promise<Hex> {
    const domainBytes = bytesToUint8Array(new TextEncoder().encode(domain));
    const { payloadBytes, sig } = await buildGovPayload('register_domain', {
      domain,
      admin_card_address: toBase64url(hexToBytes(adminCardAddress)),
      admin_secp256r1_key: toBase64url(adminSecpKey),
    });
    return submitGovTx('registerDomain', [
      domainBytes,
      adminCardAddress,
      bytesToUint8Array(adminSecpKey),
      bytesToUint8Array(payloadBytes),
      [bytesToUint8Array(sig)],
    ]);
  }

  async function deregisterDomain(domain: string): Promise<Hex> {
    const domainBytes = bytesToUint8Array(new TextEncoder().encode(domain));
    const { payloadBytes, sig } = await buildGovPayload('deregister_domain', { domain });
    return submitGovTx('deregisterDomain', [domainBytes, bytesToUint8Array(payloadBytes), [bytesToUint8Array(sig)]]);
  }

  async function removePolicyAddressGov(domain: string, path: string): Promise<Hex> {
    const domainBytes = bytesToUint8Array(new TextEncoder().encode(domain));
    const pathBytes = bytesToUint8Array(new TextEncoder().encode(path));
    const { payloadBytes, sig } = await buildGovPayload('remove_policy_address', { domain, path });
    // Governance path: card_address = zero, press fields = empty
    return submitGovTx('removePolicyAddress', [
      domainBytes, pathBytes,
      '0x' + '00'.repeat(32),  // card_address = zero (governance path)
      '0x' + '00'.repeat(32),  // press_address = zero
      [] as number[],           // press_sig_payload = empty
      [] as number[],           // press_signature = empty
      bytesToUint8Array(payloadBytes),
      [bytesToUint8Array(sig)],
    ]);
  }

  async function clearDomainEntries(domain: string, paths: string[]): Promise<Hex> {
    const domainBytes = bytesToUint8Array(new TextEncoder().encode(domain));
    const pathsBytes = paths.map(p => bytesToUint8Array(new TextEncoder().encode(p)));
    const { payloadBytes, sig } = await buildGovPayload('clear_domain_entries', { domain, paths });
    return submitGovTx('clearDomainEntries', [domainBytes, pathsBytes, bytesToUint8Array(payloadBytes), [bytesToUint8Array(sig)]]);
  }

  async function governanceSetPolicyAddressAuto(domain: string, path: string, value: Hex): Promise<Hex> {
    const domainBytes = bytesToUint8Array(new TextEncoder().encode(domain));
    const pathBytes = bytesToUint8Array(new TextEncoder().encode(path));
    const { payloadBytes, sig } = await buildGovPayload('governance_set_policy_address', {
      domain,
      path,
      policy_card_address: toBase64url(hexToBytes(value)),
    });
    return submitGovTx('governanceSetPolicyAddress', [
      domainBytes,
      pathBytes,
      value,
      bytesToUint8Array(payloadBytes),
      [bytesToUint8Array(sig)],
    ]);
  }


  // ── Board escalation payload (NOT submitted by scripts) ───────────────────

  async function generateEscalationPayload(
    operation: 'FlagDomainFraudRisk' | 'GovernanceSetPolicyAddress' | 'SetDnsGovernancePolicyAddress',
    fields: Record<string, unknown>,
  ): Promise<EscalationPayload> {
    const version = await getGovVersion();
    const nonce = generateNonce();
    const payload: Record<string, unknown> = {
      op: operation.replace(/([A-Z])/g, '_$1').toLowerCase().slice(1),
      ...fields,
      governance_version: version,
      nonce,
      timestamp: new Date().toISOString(),
    };
    const payloadBytes = canonicalize(payload);
    const hash = keccak256(payloadBytes);
    const payloadJson = new TextDecoder().decode(payloadBytes);
    const payloadHash = ('0x' + Buffer.from(hash).toString('hex')) as Hex;

    return {
      operation,
      payloadJson,
      payloadHash,
      instructions:
        `BOARD ACTION REQUIRED: ${operation}\n` +
        `Payload hash: ${payloadHash}\n` +
        `Each operator must sign keccak256(payload_bytes) with their DnsGovernanceBody secp256r1 key\n` +
        `and submit the transaction via the governance CLI.\n` +
        `Payload JSON:\n${payloadJson}`,
    };
  }

  return {
    getDomainRegistration,
    getCardEntry,
    cardExists,
    getSubCardEntry,
    getDnsAdminCardKey,
    fetchPolicyAddressSetEvents,
    getLatestBlock,
    registerDomain,
    deregisterDomain,
    removePolicyAddressGov,
    clearDomainEntries,
    governanceSetPolicyAddressAuto,
    generateEscalationPayload,
  };
}
