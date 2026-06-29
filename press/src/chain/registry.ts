/**
 * Arbitrum One registry contract client.
 *
 * Wraps all press-callable write operations (RegisterCard, UpdateCardHead,
 * ClaimOpenOffer, RegisterSubCard, DeregisterSubCard, BatchUpdateCardHeads)
 * and read operations (GetCardEntry, GetPressAuthorization, etc.).
 *
 * Each write operation:
 *   1. Fetches next_sequence from the contract (never cached — spec §5.7).
 *   2. Builds and RFC 8785-serializes the payload.
 *   3. Signs keccak256(payload_bytes) with secp256r1.
 *   4. Submits the transaction and awaits confirmation.
 *   5. On E-07 (SEQUENCE_MISMATCH): re-fetches sequence and retries once.
 *   6. UpdateCardHead additionally retries once on E-08 (STALE_PREV_CID → P-12).
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  decodeFunctionResult,
  parseAbi,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';
import type { PressConfig } from '../config.js';
import { canonicalize } from '../serialization.js';
import { secp256r1Sign, keccak256, toBase64url } from '../functions/crypto.js';

// ---------------------------------------------------------------------------
// ABI — press-callable functions only (derived from registry_contract.md §4–5)
// ---------------------------------------------------------------------------

const REGISTRY_ABI = parseAbi([
  // Write operations
  'function RegisterCard(bytes32 card_address, bytes initial_log_cid, bytes32 policy_address, bytes press_sig_payload, bytes press_signature) external',
  'function UpdateCardHead(bytes32 card_address, bytes new_log_cid, bytes press_sig_payload, bytes press_signature) external',
  'function ClaimOpenOffer(bytes32 offer_id, uint64 max_acceptances, uint64 expires_at, bytes32 card_address, bytes initial_log_cid, bytes32 policy_address, bytes press_sig_payload, bytes press_signature) external',
  'function RegisterSubCard(bytes32 sub_card_address, bytes32 master_card_address, bytes registration_log_head, bytes sub_card_doc_cid, bytes master_sig_payload, bytes master_signature, bytes admin_secp_payload, bytes admin_secp_signature) external',
  'function DeregisterSubCard(bytes32 sub_card_address, bytes sig_payload, bytes signature) external',
  'function BatchUpdateCardHeads(bytes32 policy_address, (bytes32 card_address, bytes prev_log_cid, bytes new_log_cid)[] updates, bytes press_sig_payload, bytes press_signature) external',
  // Read operations
  'function GetCardEntry(bytes32 card_address) external view returns (bytes log_head_cid, bytes32 policy_address, bytes32 last_press_address, bytes32 forward_to, bool exists)',
  'function GetPressAuthorization(bytes32 policy_address, bytes32 press_address) external view returns (bytes press_public_key, bytes32 mldsa44_key_hash, uint8 key_scheme, bool active, uint64 next_sequence, uint64 authorized_at, uint64 revoked_at)',
  'function GetOpenOfferUseCount(bytes32 offer_id) external view returns (uint64 use_count)',
  'function GetSubCardEntry(bytes32 sub_card_address) external view returns (bytes32 master_card_address, bytes registration_log_head, bytes sub_card_doc_cid, bool active, uint64 registered_at, uint64 deregistered_at)',
  'function get_protocol_version() external view returns (string)',
]);

// On-chain revert selectors the press needs to act on.
const E07_SEQUENCE_MISMATCH = 'SEQUENCE_MISMATCH';
const E08_STALE_PREV_CID = 'STALE_PREV_CID';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CardEntry {
  log_head_cid: Uint8Array;
  policy_address: Hex;
  last_press_address: Hex;
  forward_to: Hex;
  exists: boolean;
}

export interface PressAuthEntry {
  press_public_key: Uint8Array;
  mldsa44_key_hash: Hex;
  key_scheme: number;
  active: boolean;
  next_sequence: bigint;
  authorized_at: bigint;
  revoked_at: bigint;
}

export interface SubCardEntry {
  master_card_address: Hex;
  registration_log_head: Uint8Array;
  sub_card_doc_cid: Uint8Array;
  active: boolean;
  registered_at: bigint;
  deregistered_at: bigint;
}

export interface BatchUpdate {
  card_address: Hex;
  prev_log_cid: Uint8Array;
  new_log_cid: Uint8Array;
}

export interface RegistryClient {
  getCardEntry(cardAddress: Hex): Promise<CardEntry>;
  getPressAuthorization(policyAddress: Hex, pressAddress: Hex): Promise<PressAuthEntry>;
  getNextSequence(policyAddress: Hex): Promise<bigint>;
  getOpenOfferUseCount(offerId: Hex): Promise<bigint>;
  getSubCardEntry(subCardAddress: Hex): Promise<SubCardEntry>;
  /** Read the current protocol version string from the logic contract. */
  getProtocolVersion(): Promise<string>;

  registerCard(params: RegisterCardParams): Promise<Hex>;
  updateCardHead(params: UpdateCardHeadParams): Promise<Hex>;
  claimOpenOffer(params: ClaimOpenOfferParams): Promise<Hex>;
  registerSubCard(params: RegisterSubCardParams): Promise<Hex>;
  deregisterSubCard(params: DeregisterSubCardParams): Promise<Hex>;
  batchUpdateCardHeads(params: BatchUpdateParams): Promise<Hex>;

  getPressEthBalance(): Promise<bigint>;
  estimateGas(functionName: string, args: unknown[]): Promise<bigint>;
}

export interface RegisterCardParams {
  cardAddress: Hex;
  initialLogCid: Uint8Array;
  policyAddress: Hex;
}

export interface UpdateCardHeadParams {
  cardAddress: Hex;
  prevLogCid: Uint8Array;
  newLogCid: Uint8Array;
}

export interface ClaimOpenOfferParams {
  offerId: Hex;
  maxAcceptances: bigint;
  expiresAt: bigint;
  cardAddress: Hex;
  initialLogCid: Uint8Array;
  policyAddress: Hex;
}

export interface RegisterSubCardParams {
  subCardAddress: Hex;
  masterCardAddress: Hex;
  registrationLogHead: Uint8Array;
  subCardDocCid: Uint8Array;
  masterSigPayload: Uint8Array;
  masterSignature: Uint8Array;
  adminSecpPayload: Uint8Array;
  adminSecpSignature: Uint8Array;
}

export interface DeregisterSubCardParams {
  subCardAddress: Hex;
  sigPayload: Uint8Array;
  signature: Uint8Array;
}

export interface BatchUpdateParams {
  policyAddress: Hex;
  updates: BatchUpdate[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRegistryClient(config: PressConfig): RegistryClient {
  // Signing account: the secp256r1 key whose pubkey is registered on-chain in PressAuthorizations.
  // Used only for signing press payloads — never submits transactions directly.
  const account: Account = privateKeyToAccount(
    (config.PRESS_SECP256R1_PRIVATE_KEY.startsWith('0x')
      ? config.PRESS_SECP256R1_PRIVATE_KEY
      : `0x${config.PRESS_SECP256R1_PRIVATE_KEY}`) as Hex
  );

  // Gas wallet: a separate Ethereum account that holds ETH and pays transaction fees.
  // msg.sender on all transactions is this account, not the press signing account.
  const gasAccount: Account = privateKeyToAccount(
    (config.PRESS_GAS_WALLET_PRIVATE_KEY.startsWith('0x')
      ? config.PRESS_GAS_WALLET_PRIVATE_KEY
      : `0x${config.PRESS_GAS_WALLET_PRIVATE_KEY}`) as Hex
  );

  const publicClient: PublicClient = createPublicClient({
    chain: arbitrum,
    transport: http(config.ARBITRUM_RPC_URL),
  });

  // walletClient uses the gas wallet for tx submission.
  const walletClient: WalletClient = createWalletClient({
    account: gasAccount,
    chain: arbitrum,
    transport: http(config.ARBITRUM_RPC_URL),
  });

  const contractAddress = config.REGISTRY_CONTRACT_ADDRESS as Hex;

  // ---- helpers ----

  async function getNextSequence(policyAddress: Hex): Promise<bigint> {
    const auth = await getPressAuthorization(policyAddress, account.address);
    return auth.next_sequence;
  }

  async function getPressAuthorization(
    policyAddress: Hex,
    pressAddress: Hex
  ): Promise<PressAuthEntry> {
    const result = await publicClient.readContract({
      address: contractAddress,
      abi: REGISTRY_ABI,
      functionName: 'GetPressAuthorization',
      args: [policyAddress, pressAddress],
    });
    const [press_public_key, mldsa44_key_hash, key_scheme, active, next_sequence, authorized_at, revoked_at] = result as unknown as [Uint8Array, Hex, number, boolean, bigint, bigint, bigint];
    return { press_public_key: new Uint8Array(press_public_key), mldsa44_key_hash, key_scheme, active, next_sequence, authorized_at, revoked_at };
  }

  function buildAndSignPayload(
    op: string,
    fields: Record<string, unknown>,
    sequence: bigint,
    policyAddress: Hex
  ): { payloadBytes: Uint8Array; pressSignature: Uint8Array } {
    const payload: Record<string, unknown> = {
      op,
      ...fields,
      press_address: toBase64url(hexToBytes(account.address)),
      sequence: Number(sequence),
      timestamp: new Date().toISOString(),
    };
    const payloadBytes = canonicalize(payload);
    const hash = keccak256(payloadBytes);
    const pressSignature = secp256r1Sign(config.PRESS_SECP256R1_PRIVATE_KEY, hash);
    return { payloadBytes, pressSignature };
  }

  async function submitWithRetry(
    functionName: string,
    buildArgs: (sequence: bigint) => unknown[],
    policyAddress: Hex,
    retries = 1
  ): Promise<Hex> {
    let seq = await getNextSequence(policyAddress);
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const args = buildArgs(seq);
        const hash = await walletClient.writeContract({
          address: contractAddress,
          abi: REGISTRY_ABI,
          functionName: functionName as never,
          args: args as never,
          account: gasAccount,
          chain: arbitrum,
        });
        await publicClient.waitForTransactionReceipt({ hash });
        return hash;
      } catch (err) {
        const msg = String(err);
        if (attempt < retries && msg.includes(E07_SEQUENCE_MISMATCH)) {
          seq = await getNextSequence(policyAddress);
          continue;
        }
        throw err;
      }
    }
    throw new Error('unreachable');
  }

  // ---- reads ----

  async function getCardEntry(cardAddress: Hex): Promise<CardEntry> {
    const result = await publicClient.readContract({
      address: contractAddress,
      abi: REGISTRY_ABI,
      functionName: 'GetCardEntry',
      args: [cardAddress],
    });
    const [log_head_cid, policy_address, last_press_address, forward_to, exists] = result as unknown as [Uint8Array, Hex, Hex, Hex, boolean];
    return {
      log_head_cid: new Uint8Array(log_head_cid),
      policy_address,
      last_press_address,
      forward_to,
      exists,
    };
  }

  async function getOpenOfferUseCount(offerId: Hex): Promise<bigint> {
    const result = await publicClient.readContract({
      address: contractAddress,
      abi: REGISTRY_ABI,
      functionName: 'GetOpenOfferUseCount',
      args: [offerId],
    });
    return result as bigint;
  }

  async function getProtocolVersion(): Promise<string> {
    const result = await publicClient.readContract({
      address: contractAddress,
      abi: REGISTRY_ABI,
      functionName: 'get_protocol_version',
      args: [],
    });
    return result as string;
  }

  async function getSubCardEntry(subCardAddress: Hex): Promise<SubCardEntry> {
    const result = await publicClient.readContract({
      address: contractAddress,
      abi: REGISTRY_ABI,
      functionName: 'GetSubCardEntry',
      args: [subCardAddress],
    });
    const [master_card_address, registration_log_head, sub_card_doc_cid, active, registered_at, deregistered_at] = result as unknown as [Hex, Uint8Array, Uint8Array, boolean, bigint, bigint];
    return {
      master_card_address,
      registration_log_head: new Uint8Array(registration_log_head),
      sub_card_doc_cid: new Uint8Array(sub_card_doc_cid),
      active,
      registered_at,
      deregistered_at,
    };
  }

  // ---- writes ----

  async function registerCard(params: RegisterCardParams): Promise<Hex> {
    return submitWithRetry(
      'RegisterCard',
      (seq) => {
        const { payloadBytes, pressSignature } = buildAndSignPayload(
          'register_card',
          {
            card_address: toBase64url(hexToBytes(params.cardAddress)),
            initial_log_cid: toBase64url(params.initialLogCid),
            policy_address: toBase64url(hexToBytes(params.policyAddress)),
          },
          seq,
          params.policyAddress
        );
        return [
          params.cardAddress,
          params.initialLogCid,
          params.policyAddress,
          payloadBytes,
          pressSignature,
        ];
      },
      params.policyAddress
    );
  }

  async function updateCardHead(params: UpdateCardHeadParams): Promise<Hex> {
    // Resolve the policy address from the card entry (needed for sequence fetch).
    const entry = await getCardEntry(params.cardAddress);
    const policyAddress = entry.policy_address;

    let prevLogCid = params.prevLogCid;
    const MAX_RETRIES = 1;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await submitWithRetry(
          'UpdateCardHead',
          (seq) => {
            const { payloadBytes, pressSignature } = buildAndSignPayload(
              'update_card_head',
              {
                card_address: toBase64url(hexToBytes(params.cardAddress)),
                prev_log_cid: toBase64url(prevLogCid),
                new_log_cid: toBase64url(params.newLogCid),
              },
              seq,
              policyAddress
            );
            return [params.cardAddress, params.newLogCid, payloadBytes, pressSignature];
          },
          policyAddress
        );
      } catch (err) {
        const msg = String(err);
        if (attempt < MAX_RETRIES && msg.includes(E08_STALE_PREV_CID)) {
          // Re-read the on-chain head and retry once.
          const refreshed = await getCardEntry(params.cardAddress);
          prevLogCid = refreshed.log_head_cid;
          continue;
        }
        if (msg.includes(E08_STALE_PREV_CID)) {
          throw Object.assign(
            new Error('P-12: STALE_PREV_CID on retry — concurrent log head conflict'),
            { pressCode: 'P-12' }
          );
        }
        throw err;
      }
    }
    throw new Error('unreachable');
  }

  async function claimOpenOffer(params: ClaimOpenOfferParams): Promise<Hex> {
    return submitWithRetry(
      'ClaimOpenOffer',
      (seq) => {
        const { payloadBytes, pressSignature } = buildAndSignPayload(
          'claim_open_offer',
          {
            offer_id: toBase64url(hexToBytes(params.offerId)),
            card_address: toBase64url(hexToBytes(params.cardAddress)),
            initial_log_cid: toBase64url(params.initialLogCid),
            policy_address: toBase64url(hexToBytes(params.policyAddress)),
          },
          seq,
          params.policyAddress
        );
        return [
          params.offerId,
          params.maxAcceptances,
          params.expiresAt,
          params.cardAddress,
          params.initialLogCid,
          params.policyAddress,
          payloadBytes,
          pressSignature,
        ];
      },
      params.policyAddress
    );
  }

  async function registerSubCard(params: RegisterSubCardParams): Promise<Hex> {
    // Sub-card registration uses the master card's policy. Look it up.
    const masterEntry = await getCardEntry(params.masterCardAddress);
    const policyAddress = masterEntry.policy_address;

    return submitWithRetry(
      'RegisterSubCard',
      (seq) => {
        const { payloadBytes, pressSignature } = buildAndSignPayload(
          'register_sub_card',
          {
            sub_card_address: toBase64url(hexToBytes(params.subCardAddress)),
            master_card_address: toBase64url(hexToBytes(params.masterCardAddress)),
            registration_log_head: toBase64url(params.registrationLogHead),
            sub_card_doc_cid: toBase64url(params.subCardDocCid),
          },
          seq,
          policyAddress
        );
        return [
          params.subCardAddress,
          params.masterCardAddress,
          params.registrationLogHead,
          params.subCardDocCid,
          params.masterSigPayload,
          params.masterSignature,
          params.adminSecpPayload,
          params.adminSecpSignature,
        ];
      },
      policyAddress
    );
  }

  async function deregisterSubCard(params: DeregisterSubCardParams): Promise<Hex> {
    const subEntry = await getSubCardEntry(params.subCardAddress);
    const masterEntry = await getCardEntry(subEntry.master_card_address);
    const policyAddress = masterEntry.policy_address;

    return submitWithRetry(
      'DeregisterSubCard',
      (_seq) => [params.subCardAddress, params.sigPayload, params.signature],
      policyAddress
    );
  }

  async function batchUpdateCardHeads(params: BatchUpdateParams): Promise<Hex> {
    if (params.updates.length === 0 || params.updates.length > config.MAX_BATCH_SIZE) {
      throw new Error(
        `BatchUpdateCardHeads: update count ${params.updates.length} out of range [1, ${config.MAX_BATCH_SIZE}]`
      );
    }
    return submitWithRetry(
      'BatchUpdateCardHeads',
      (seq) => {
        const { payloadBytes, pressSignature } = buildAndSignPayload(
          'batch_update_card_heads',
          {
            policy_address: toBase64url(hexToBytes(params.policyAddress)),
            updates: params.updates.map((u) => ({
              card_address: toBase64url(hexToBytes(u.card_address)),
              prev_log_cid: toBase64url(u.prev_log_cid),
              new_log_cid: toBase64url(u.new_log_cid),
            })),
          },
          seq,
          params.policyAddress
        );
        const abiUpdates = params.updates.map((u) => ({
          card_address: u.card_address,
          prev_log_cid: u.prev_log_cid,
          new_log_cid: u.new_log_cid,
        }));
        return [params.policyAddress, abiUpdates, payloadBytes, pressSignature];
      },
      params.policyAddress
    );
  }

  async function getPressEthBalance(): Promise<bigint> {
    return publicClient.getBalance({ address: account.address });
  }

  async function estimateGas(functionName: string, args: unknown[]): Promise<bigint> {
    return publicClient.estimateContractGas({
      address: contractAddress,
      abi: REGISTRY_ABI,
      functionName: functionName as never,
      args: args as never,
      account,
    });
  }

  return {
    getCardEntry,
    getPressAuthorization: (policyAddress, pressAddress) =>
      getPressAuthorization(policyAddress, pressAddress),
    getNextSequence,
    getOpenOfferUseCount,
    getSubCardEntry,
    getProtocolVersion,
    registerCard,
    updateCardHead,
    claimOpenOffer,
    registerSubCard,
    deregisterSubCard,
    batchUpdateCardHeads,
    getPressEthBalance,
    estimateGas,
  };
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function hexToBytes(hex: Hex): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
