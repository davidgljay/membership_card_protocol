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
// Logic contract function names follow Stylus SDK's PascalCase export convention.

const LOGIC_ABI = parseAbi([
  // ── DNS governance write operations (script-authorized, §4.17–4.21, §4.23) ─
  'function RegisterDomain(bytes domain, bytes32 admin_card_address, bytes admin_secp256r1_key, bytes governance_payload, bytes[] governance_sigs) external',
  'function DeregisterDomain(bytes domain, bytes governance_payload, bytes[] governance_sigs) external',
  'function RemovePolicyAddress(bytes domain, bytes path, bytes32 card_address, bytes32 press_address, bytes press_sig_payload, bytes press_signature, bytes governance_payload, bytes[] governance_sigs) external',
  'function ClearDomainEntries(bytes domain, bytes[] paths, bytes governance_payload, bytes[] governance_sigs) external',
  'function GovernanceSetPolicyAddress(bytes domain, bytes path, bytes32 policy_card_address, bytes governance_payload, bytes[] governance_sigs) external',

  // ── DNS governance write operations (board-only, §4.22, §4.24) ───────────
  // These are NOT called by scripts; payloads are generated for human operators.
  'function FlagDomainFraudRisk(bytes domain, uint8 fraud_risk, uint64 suspension_expires_at, bytes governance_payload, bytes[] governance_sigs) external',
  'function SetDnsGovernancePolicyAddress(bytes32 new_policy_address, bytes governance_payload, bytes[] governance_sigs) external',

  // ── Read operations ───────────────────────────────────────────────────────
  'function GetCardEntry(bytes32 card_address) external view returns (bytes log_head_cid, bytes32 policy_address, bytes32 last_press_address, bytes32 forward_to, bool exists)',
  'function CardExists(bytes32 card_address) external view returns (bool)',
  'function GetSubCardEntry(bytes32 sub_card_address) external view returns (bytes32 master_card_address, bytes registration_log_head, bytes sub_card_doc_cid, bool active, uint64 registered_at, uint64 deregistered_at)',
  'function GetDomainRegistration(bytes domain) external view returns (bytes32 admin_card_address, uint64 registered_at, uint8 fraud_risk, uint64 suspension_expires_at, bool exists)',
  'function GetGovernanceKeyset(uint8 body_id) external view returns (bytes keys_flat, uint8 key_count, uint8 quorum, uint32 version, uint8 key_scheme)',
  'function IsNonceUsed(bytes32 nonce) external view returns (bool)',
  'function GetPressAuthorization(bytes32 policy_address, bytes32 press_address) external view returns (bytes press_public_key, bytes32 mldsa44_key_hash, uint8 key_scheme, bool active, uint64 next_sequence, uint64 authorized_at, uint64 revoked_at)',
  'function LookupPolicyAddress(bytes domain, bytes path) external view returns (bytes32)',
  'function GetDnsAdminCardKey(bytes32 card_address) external view returns (bytes)',
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
      functionName: 'GetGovernanceKeyset',
      args: [DNS_GOVERNANCE_BODY],
    });
    const [,,,version] = result as unknown as [Uint8Array, number, number, number, number];
    return version;
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
      functionName: 'GetDomainRegistration',
      args: [bytesToHex(new TextEncoder().encode(domain))],
    });
    const [admin, regAt, fr, sus, exists] = result as unknown as [Hex, bigint, number, bigint, boolean];
    return { adminCardAddress: admin, registeredAt: regAt, fraudRisk: fr, suspensionExpiresAt: sus, exists };
  }

  async function getCardEntry(cardAddress: Hex): Promise<CardEntry> {
    const result = await publicClient.readContract({
      address: logicAddr,
      abi: LOGIC_ABI,
      functionName: 'GetCardEntry',
      args: [cardAddress],
    });
    const [cid, policy, press, fwd, exists] = result as unknown as [Uint8Array, Hex, Hex, Hex, boolean];
    return { logHeadCid: new Uint8Array(cid), policyAddress: policy, lastPressAddress: press, forwardTo: fwd, exists };
  }

  async function cardExists(cardAddress: Hex): Promise<boolean> {
    return publicClient.readContract({
      address: logicAddr,
      abi: LOGIC_ABI,
      functionName: 'CardExists',
      args: [cardAddress],
    }) as Promise<boolean>;
  }

  async function getSubCardEntry(subCardAddress: Hex): Promise<SubCardEntry> {
    const result = await publicClient.readContract({
      address: logicAddr,
      abi: LOGIC_ABI,
      functionName: 'GetSubCardEntry',
      args: [subCardAddress],
    });
    const [master, regHead, docCid, active, regAt, deregAt] = result as unknown as [Hex, Uint8Array, Uint8Array, boolean, bigint, bigint];
    return {
      masterCardAddress: master,
      registrationLogHead: new Uint8Array(regHead),
      subCardDocCid: new Uint8Array(docCid),
      active,
      registeredAt: regAt,
      deregisteredAt: deregAt,
    };
  }

  async function getDnsAdminCardKey(cardAddress: Hex): Promise<Uint8Array> {
    const result = await publicClient.readContract({
      address: logicAddr,
      abi: LOGIC_ABI,
      functionName: 'GetDnsAdminCardKey',
      args: [cardAddress],
    });
    return hexBytesResult(result);
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
    const domainBytes = new TextEncoder().encode(domain);
    const { payloadBytes, sig } = await buildGovPayload('register_domain', {
      domain,
      admin_card_address: toBase64url(hexToBytes(adminCardAddress)),
      admin_secp256r1_key: toBase64url(adminSecpKey),
    });
    return submitGovTx('RegisterDomain', [domainBytes, adminCardAddress, adminSecpKey, payloadBytes, [sig]]);
  }

  async function deregisterDomain(domain: string): Promise<Hex> {
    const domainBytes = new TextEncoder().encode(domain);
    const { payloadBytes, sig } = await buildGovPayload('deregister_domain', { domain });
    return submitGovTx('DeregisterDomain', [domainBytes, payloadBytes, [sig]]);
  }

  async function removePolicyAddressGov(domain: string, path: string): Promise<Hex> {
    const domainBytes = new TextEncoder().encode(domain);
    const pathBytes = new TextEncoder().encode(path);
    const { payloadBytes, sig } = await buildGovPayload('remove_policy_address', { domain, path });
    // Governance path: card_address = zero, press fields = empty
    return submitGovTx('RemovePolicyAddress', [
      domainBytes, pathBytes,
      '0x' + '00'.repeat(32),  // card_address = zero (governance path)
      '0x' + '00'.repeat(32),  // press_address = zero
      new Uint8Array(0),        // press_sig_payload = empty
      new Uint8Array(0),        // press_signature = zero
      payloadBytes,
      [sig],
    ]);
  }

  async function clearDomainEntries(domain: string, paths: string[]): Promise<Hex> {
    const domainBytes = new TextEncoder().encode(domain);
    const pathsBytes = paths.map(p => new TextEncoder().encode(p));
    const { payloadBytes, sig } = await buildGovPayload('clear_domain_entries', { domain, paths });
    return submitGovTx('ClearDomainEntries', [domainBytes, pathsBytes, payloadBytes, [sig]]);
  }

  async function governanceSetPolicyAddressAuto(domain: string, path: string, value: Hex): Promise<Hex> {
    const domainBytes = new TextEncoder().encode(domain);
    const pathBytes = new TextEncoder().encode(path);
    const { payloadBytes, sig } = await buildGovPayload('governance_set_policy_address', {
      domain,
      path,
      policy_card_address: toBase64url(hexToBytes(value)),
    });
    return submitGovTx('GovernanceSetPolicyAddress', [domainBytes, pathBytes, value, payloadBytes, [sig]]);
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
