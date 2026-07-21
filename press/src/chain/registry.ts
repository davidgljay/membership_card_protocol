/**
 * Arbitrum One registry contract client.
 *
 * Wraps all press-callable write operations (registerCard, updateCardHead,
 * claimOpenOffer, registerSubCard, deregisterSubCard, batchUpdateCardHeads)
 * and read operations (getCardEntry, getPressAuthorization, etc.).
 *
 * Each write operation:
 *   1. Fetches next_sequence from the contract (never cached — spec §5.7).
 *   2. Builds and RFC 8785-serializes the payload.
 *   3. Signs keccak256(payload_bytes) with secp256r1.
 *   4. Submits the transaction and awaits confirmation.
 *   5. On E-07 (SEQUENCE_MISMATCH): re-fetches sequence and retries once.
 *   6. updateCardHead additionally retries once on E-08 (STALE_PREV_CID → P-12).
 *
 * ABI note (2026-07-20): every function name/parameter list below is taken
 * from `cargo stylus export-abi`'s actual output for the deployed contracts
 * — not from `registry_contract.md`'s ASCII diagrams, which turned out to
 * omit real parameters in several places (e.g. `RegisterSubCard`'s diagram
 * shows no press signature fields at all; the compiled contract requires
 * `press_address`/`press_sig_payload`/`press_signature` on every write, and
 * `BatchUpdateCardHeads`'s `UpdateItem[]` is actually three parallel arrays
 * on the wire). Function names are camelCase (Stylus SDK converts Rust
 * snake_case for ABI dispatch) and every `Vec<u8>` is `uint8[]`, not
 * `bytes` — confirmed by a previous casing-only fix reverting against the
 * live contract until both of these were corrected together. Reads go to
 * the **storage** contract, not logic — `getSubCardEntry`/`getOpenOfferCount`
 * exist only there (logic never re-exposes them), and storage's address is
 * the protocol's stable identifier (`registry_contract.md §1`), so reads
 * through it don't silently break on the next logic upgrade the way reads
 * through logic's mirrored getters would.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, arbitrumSepolia } from 'viem/chains';
import type { PressConfig } from '../config.js';
import { canonicalize } from '../serialization.js';
import { secp256r1Sign, keccak256, toBase64url } from '../functions/crypto.js';

// ---------------------------------------------------------------------------
// ABIs — from `cargo stylus export-abi` against the deployed contracts, not
// hand-transcribed from Rust source or the spec's diagrams (see file doc).
// ---------------------------------------------------------------------------

const LOGIC_ABI = parseAbi([
  'function registerCard(bytes32 card_address, uint8[] initial_log_cid, bytes32 policy_address, bytes32 press_address, uint8[] press_sig_payload, uint8[] press_signature) external',
  'function updateCardHead(bytes32 card_address, uint8[] new_log_cid, uint8[] prev_log_cid, bytes32 press_address, uint8[] press_sig_payload, uint8[] press_signature) external',
  'function claimOpenOffer(bytes32 offer_id, uint64 max_acceptances, uint64 expires_at, bytes32 card_address, uint8[] initial_log_cid, bytes32 policy_address, bytes32 press_address, uint8[] press_sig_payload, uint8[] press_signature) external',
  'function registerSubCard(bytes32 sub_card_address, bytes32 master_card_address, uint8[] registration_log_head, uint8[] sub_card_doc_cid, bytes32 press_address, uint8[] press_sig_payload, uint8[] press_signature, uint8[] master_sig_payload, uint8[] master_signature, uint8[] admin_secp_payload, uint8[] admin_secp_signature) external',
  'function deregisterSubCard(bytes32 sub_card_address, bytes32 press_address, uint8[] press_sig_payload, uint8[] press_signature, uint8[] sig_payload, uint8[] signature) external',
  'function batchUpdateCardHeads(bytes32 policy_address, bytes32 press_address, bytes32[] card_addresses, uint8[][] prev_log_cids, uint8[][] new_log_cids, uint8[] press_sig_payload, uint8[] press_signature) external',
  'function getProtocolVersion() external view returns (string)',
]);

// getCardEntry/getPressAuthorization/getSubCardEntry each mix a uint8[]
// into a multi-value return — viem/the ABI encoder wraps that as an extra
// 32-byte outer tuple offset that a plain comma-separated `returns (...)`
// declaration doesn't account for, causing a PositionOutOfBoundsError on
// decode (confirmed against the live contract). Declaring the return as a
// single named tuple makes viem expect that outer offset. Same fix already
// documented for `getCardEntry` in an earlier contracts-side investigation
// (see project memory) — this is that fix applied to press's own ABI.
// Log events (§7) — plain Solidity event ABI-encoding, unlike the function
// ABIs above: the `uint8[]`-not-`bytes` quirk documented there is specific
// to Stylus's function-dispatch selector generation for `Vec<u8>`
// parameters, and doesn't apply to event logs, which follow standard
// Solidity event encoding regardless of the contract's implementation
// language. `bytes` here matches `logic-contract/src/lib.rs`'s `sol!`
// event declarations directly. Declared separately (not as one combined
// array) since viem can't infer a shared `args` filter type across events
// with different non-indexed parameter shapes.
const CARD_REGISTERED_EVENT = parseAbi([
  'event CardRegistered(bytes32 indexed card_address, bytes32 indexed policy_address, bytes32 press_address, bytes initial_log_cid, uint64 timestamp)',
]);
const CARD_HEAD_UPDATED_EVENT = parseAbi([
  'event CardHeadUpdated(bytes32 indexed card_address, bytes prev_log_cid, bytes new_log_cid, bytes32 press_address, uint64 timestamp)',
]);

const STORAGE_ABI = parseAbi([
  'function getCardEntry(bytes32 card_address) external view returns ((uint8[] log_head_cid, bytes32 policy_address, bytes32 last_press_address, bytes32 forward_to, bool exists) r)',
  'function getPressAuthorization(bytes32 policy_address, bytes32 press_address) external view returns ((uint8[] press_public_key, bytes32 mldsa44_key_hash, uint8 key_scheme, bool active, uint64 next_sequence, uint64 authorized_at, uint64 revoked_at) r)',
  'function getOpenOfferCount(bytes32 offer_id) external view returns (uint64)',
  'function getSubCardEntry(bytes32 sub_card_address) external view returns ((bytes32 master_card_address, uint8[] registration_log_head, uint8[] sub_card_doc_cid, bool active, uint64 registered_at, uint64 deregistered_at) r)',
  'function policyExists(bytes32 policy_address) external view returns (bool)',
]);

// On-chain revert selectors the press needs to act on.
const E07_SEQUENCE_MISMATCH = 'SEQUENCE_MISMATCH';
const E08_STALE_PREV_CID = 'STALE_PREV_CID';

// A zero bytes32 forward_to means "no forward" (never set) — same sentinel
// used elsewhere in press for an absent bytes32.
const ZERO_BYTES32 = ('0x' + '00'.repeat(32)) as Hex;
// admin_secp_signature must be exactly bytes[64](0) when the master card is
// not a DNS admin card (`registry_contract.md §4.3`) — the contract rejects
// any other all-zero-length value for that slot.
const ZERO_ADMIN_SECP_SIGNATURE = new Uint8Array(64);

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

export interface CardChainEvent {
  cid: Uint8Array;
  /** On-chain block timestamp (§7's `timestamp uint64`, seconds since epoch). */
  timestamp: bigint;
}

export interface RegistryClient {
  /**
   * This press's own on-chain `PressAuthorizations` lookup key (secp256r1
   * gas-account address, bytes32-padded) — a separate identity from
   * `context.ts`'s `pressAddress` (keccak256 of the ML-DSA-44
   * content-signing key, exposed as `/api/press`'s `address` field). A
   * caller needing to check `getPressAuthorization` for this press (e.g.
   * wallet-sdk's `reviewTargetedOffer`, which requires a caller-supplied
   * on-chain press address it cannot derive from a content CID) needs this
   * value; see `/api/press`'s `gas_address` field.
   */
  readonly pressGasAddress: Hex;
  getCardEntry(cardAddress: Hex): Promise<CardEntry>;
  getPressAuthorization(policyAddress: Hex, pressAddress: Hex): Promise<PressAuthEntry>;
  getNextSequence(policyAddress: Hex): Promise<bigint>;
  getOpenOfferUseCount(offerId: Hex): Promise<bigint>;
  getSubCardEntry(subCardAddress: Hex): Promise<SubCardEntry>;
  /** Read the current protocol version string from the logic contract. */
  getProtocolVersion(): Promise<string>;
  /**
   * Ground-truth on-chain event replay for a card's log — every
   * `CardRegistered`/`CardHeadUpdated` event naming this card address, in
   * chronological order. There is no on-chain-enumerable per-entry log
   * (`registry_contract.md §3.1`'s `CardEntries` mapping stores only the
   * current head); this reconstructs it from event history, the same
   * ground truth `CardVerifier`'s Stage 4 revocation check cross-references
   * against a card's self-reported `history` (`registry_contract.md §7`).
   */
  getCardEventLog(cardAddress: Hex): Promise<CardChainEvent[]>;
  /** True if `address` is a registered policy (PolicyAuthorizerKeys, registry_contract.md §3.2) — RegisterPolicy is the only way an entry is created. */
  isPolicyAuthorizer(address: Hex): Promise<boolean>;

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
  /** Empty when the master card is not a DNS admin card (the common case). */
  adminSecpPayload?: Uint8Array;
  /** Must be exactly 64 bytes when present; omit for a non-DNS-admin master. */
  adminSecpSignature?: Uint8Array;
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

  // A hardcoded `arbitrum` (mainnet) chain object here previously made
  // writes fail against Sepolia — `eth_sendRawTransaction` rejects a
  // transaction whose signed chain ID doesn't match the RPC endpoint's
  // ("Missing or invalid parameters", confirmed against the live Sepolia
  // endpoint). Reads (`readContract`, plain `eth_call`) don't carry a
  // chain ID and were unaffected, which is why this stayed hidden until an
  // actual write was exercised. Derived from EXPECTED_CHAIN_ID rather than
  // ARBITRUM_RPC_URL's host, matching the config field that already exists
  // for exactly this purpose (see config.ts's own doc comment on it).
  const chain = config.EXPECTED_CHAIN_ID === arbitrumSepolia.id ? arbitrumSepolia : arbitrum;

  const publicClient: PublicClient = createPublicClient({
    chain,
    transport: http(config.ARBITRUM_RPC_URL),
  });

  // walletClient uses the gas wallet for tx submission.
  const walletClient: WalletClient = createWalletClient({
    account: gasAccount,
    chain,
    transport: http(config.ARBITRUM_RPC_URL),
  });

  const logicAddress = config.REGISTRY_CONTRACT_ADDRESS as Hex;
  const storageAddress = config.STORAGE_CONTRACT_ADDRESS as Hex;

  // `press_address` on-chain is `bytes32` — write_gate.rs uses it purely as
  // a PressAuthorizations[policy][press] lookup key (the actual signature
  // check is against a separately-stored press_public_key, not anything
  // derived from this value), so it just needs to be a stable, unique
  // bytes32. Left-padded to match Solidity's standard address→bytes32
  // conversion (`bytes32(uint256(uint160(address)))`) — the same value
  // AuthorizePress must have registered this press under. This secp256r1
  // account's address is a separate identity from `pressAddress`
  // (context.ts, keccak256 of the ML-DSA-44 content-signing key): chain
  // writes authenticate via secp256r1 (RIP-7212); IPFS content signing
  // uses ML-DSA-44. Both derive from different keys and are deliberately
  // not the same address.
  const pressAddress = ('0x' + account.address.slice(2).padStart(64, '0')) as Hex;

  // ---- ABI-shape helpers ----
  // uint8[] round-trips as plain number[] in viem, not Uint8Array — every
  // Vec<u8> parameter needs Array.from() going out and Uint8Array.from()
  // coming back.
  function toUint8Array(value: readonly number[]): Uint8Array {
    return Uint8Array.from(value);
  }

  // ---- helpers ----

  async function getNextSequence(policyAddress: Hex): Promise<bigint> {
    const auth = await getPressAuthorization(policyAddress, pressAddress);
    return auth.next_sequence;
  }

  async function getPressAuthorization(
    policyAddress: Hex,
    forPressAddress: Hex
  ): Promise<PressAuthEntry> {
    policyAddress = normalizeHex(policyAddress);
    forPressAddress = normalizeHex(forPressAddress);
    const result = await publicClient.readContract({
      address: storageAddress,
      abi: STORAGE_ABI,
      functionName: 'getPressAuthorization',
      args: [policyAddress, forPressAddress],
    });
    const tuple = result as unknown as {
      press_public_key: readonly number[];
      mldsa44_key_hash: Hex;
      key_scheme: number;
      active: boolean;
      next_sequence: bigint;
      authorized_at: bigint;
      revoked_at: bigint;
    };
    return {
      press_public_key: toUint8Array(tuple.press_public_key),
      mldsa44_key_hash: tuple.mldsa44_key_hash,
      key_scheme: tuple.key_scheme,
      active: tuple.active,
      next_sequence: tuple.next_sequence,
      authorized_at: tuple.authorized_at,
      revoked_at: tuple.revoked_at,
    };
  }

  function buildAndSignPayload(
    op: string,
    fields: Record<string, unknown>,
    sequence: bigint
  ): { payloadBytes: Uint8Array; pressSignature: Uint8Array } {
    const payload: Record<string, unknown> = {
      op,
      ...fields,
      press_address: toBase64url(hexToBytes(pressAddress)),
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
    console.error(`[registry] submitWithRetry(${functionName}) fetching next sequence...`);
    let seq = await getNextSequence(policyAddress);
    console.error(`[registry] submitWithRetry(${functionName}) got sequence ${seq}`);
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const args = buildArgs(seq);
        console.error(`[registry] submitWithRetry(${functionName}) attempt ${attempt}: writeContract...`);
        const hash = await walletClient.writeContract({
          address: logicAddress,
          abi: LOGIC_ABI,
          functionName: functionName as never,
          args: args as never,
          account: gasAccount,
          chain,
        });
        console.error(`[registry] submitWithRetry(${functionName}) got hash ${hash}, waiting for receipt...`);
        // The public Arbitrum Sepolia RPC has been observed to lag behind
        // its own mined blocks when polled for a receipt — transactions
        // that land successfully (confirmed separately via
        // eth_getTransactionReceipt against the same RPC minutes later)
        // still miss viem's default 180s waitForTransactionReceipt window.
        // Give it more headroom rather than surfacing a false failure for
        // a transaction that in fact succeeded.
        await publicClient.waitForTransactionReceipt({ hash, timeout: 300_000 });
        console.error(`[registry] submitWithRetry(${functionName}) confirmed`);
        return hash;
      } catch (err) {
        console.error(`[registry] submitWithRetry(${functionName}) attempt ${attempt} error:`, String(err));
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

  // ---- reads (storage contract — see file doc for why) ----

  async function getCardEntry(cardAddress: Hex): Promise<CardEntry> {
    cardAddress = normalizeHex(cardAddress);
    const result = await publicClient.readContract({
      address: storageAddress,
      abi: STORAGE_ABI,
      functionName: 'getCardEntry',
      args: [cardAddress],
    });
    const tuple = result as unknown as {
      log_head_cid: readonly number[];
      policy_address: Hex;
      last_press_address: Hex;
      forward_to: Hex;
      exists: boolean;
    };
    return {
      log_head_cid: toUint8Array(tuple.log_head_cid),
      policy_address: tuple.policy_address,
      last_press_address: tuple.last_press_address,
      forward_to: tuple.forward_to === ZERO_BYTES32 ? ZERO_BYTES32 : tuple.forward_to,
      exists: tuple.exists,
    };
  }

  async function getOpenOfferUseCount(offerId: Hex): Promise<bigint> {
    offerId = normalizeHex(offerId);
    const result = await publicClient.readContract({
      address: storageAddress,
      abi: STORAGE_ABI,
      functionName: 'getOpenOfferCount',
      args: [offerId],
    });
    return result as unknown as bigint;
  }

  async function isPolicyAuthorizer(address: Hex): Promise<boolean> {
    address = normalizeHex(address);
    const result = await publicClient.readContract({
      address: storageAddress,
      abi: STORAGE_ABI,
      functionName: 'policyExists',
      args: [address],
    });
    return result as unknown as boolean;
  }

  async function getProtocolVersion(): Promise<string> {
    return publicClient.readContract({
      address: logicAddress,
      abi: LOGIC_ABI,
      functionName: 'getProtocolVersion',
      args: [],
    });
  }

  async function getSubCardEntry(subCardAddress: Hex): Promise<SubCardEntry> {
    subCardAddress = normalizeHex(subCardAddress);
    const result = await publicClient.readContract({
      address: storageAddress,
      abi: STORAGE_ABI,
      functionName: 'getSubCardEntry',
      args: [subCardAddress],
    });
    const tuple = result as unknown as {
      master_card_address: Hex;
      registration_log_head: readonly number[];
      sub_card_doc_cid: readonly number[];
      active: boolean;
      registered_at: bigint;
      deregistered_at: bigint;
    };
    return {
      master_card_address: tuple.master_card_address,
      registration_log_head: toUint8Array(tuple.registration_log_head),
      sub_card_doc_cid: toUint8Array(tuple.sub_card_doc_cid),
      active: tuple.active,
      registered_at: tuple.registered_at,
      deregistered_at: tuple.deregistered_at,
    };
  }

  async function getCardEventLog(cardAddress: Hex): Promise<CardChainEvent[]> {
    cardAddress = normalizeHex(cardAddress);
    // Events are emitted by the logic contract, not storage (file doc, §7).
    const [registeredLogs, headUpdatedLogs] = await Promise.all([
      publicClient.getLogs({
        address: logicAddress,
        event: CARD_REGISTERED_EVENT[0],
        args: { card_address: cardAddress },
        fromBlock: 0n,
        toBlock: 'latest',
      }),
      publicClient.getLogs({
        address: logicAddress,
        event: CARD_HEAD_UPDATED_EVENT[0],
        args: { card_address: cardAddress },
        fromBlock: 0n,
        toBlock: 'latest',
      }),
    ]);

    const events = [
      ...registeredLogs.map((log) => ({
        cid: hexToBytes(log.args.initial_log_cid!),
        timestamp: log.args.timestamp!,
        blockNumber: log.blockNumber ?? 0n,
        logIndex: log.logIndex ?? 0,
      })),
      ...headUpdatedLogs.map((log) => ({
        cid: hexToBytes(log.args.new_log_cid!),
        timestamp: log.args.timestamp!,
        blockNumber: log.blockNumber ?? 0n,
        logIndex: log.logIndex ?? 0,
      })),
    ];

    return events
      .sort((a, b) =>
        a.blockNumber === b.blockNumber
          ? a.logIndex - b.logIndex
          : Number(a.blockNumber - b.blockNumber)
      )
      .map(({ cid, timestamp }) => ({ cid, timestamp }));
  }

  // ---- writes (logic contract) ----

  async function registerCard(params: RegisterCardParams): Promise<Hex> {
    params = { ...params, cardAddress: normalizeHex(params.cardAddress), policyAddress: normalizeHex(params.policyAddress) };
    return submitWithRetry(
      'registerCard',
      (seq) => {
        const { payloadBytes, pressSignature } = buildAndSignPayload(
          'register_card',
          {
            card_address: toBase64url(hexToBytes(params.cardAddress)),
            initial_log_cid: toBase64url(params.initialLogCid),
            policy_address: toBase64url(hexToBytes(params.policyAddress)),
          },
          seq
        );
        return [
          params.cardAddress,
          Array.from(params.initialLogCid),
          params.policyAddress,
          pressAddress,
          Array.from(payloadBytes),
          Array.from(pressSignature),
        ];
      },
      params.policyAddress
    );
  }

  async function updateCardHead(params: UpdateCardHeadParams): Promise<Hex> {
    params = { ...params, cardAddress: normalizeHex(params.cardAddress) };
    // Resolve the policy address from the card entry (needed for sequence fetch).
    const entry = await getCardEntry(params.cardAddress);
    const policyAddress = entry.policy_address;

    let prevLogCid = params.prevLogCid;
    const MAX_RETRIES = 1;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await submitWithRetry(
          'updateCardHead',
          (seq) => {
            const { payloadBytes, pressSignature } = buildAndSignPayload(
              'update_card_head',
              {
                card_address: toBase64url(hexToBytes(params.cardAddress)),
                prev_log_cid: toBase64url(prevLogCid),
                new_log_cid: toBase64url(params.newLogCid),
              },
              seq
            );
            return [
              params.cardAddress,
              Array.from(params.newLogCid),
              Array.from(prevLogCid),
              pressAddress,
              Array.from(payloadBytes),
              Array.from(pressSignature),
            ];
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
    params = {
      ...params,
      offerId: normalizeHex(params.offerId),
      cardAddress: normalizeHex(params.cardAddress),
      policyAddress: normalizeHex(params.policyAddress),
    };
    return submitWithRetry(
      'claimOpenOffer',
      (seq) => {
        const { payloadBytes, pressSignature } = buildAndSignPayload(
          'claim_open_offer',
          {
            offer_id: toBase64url(hexToBytes(params.offerId)),
            card_address: toBase64url(hexToBytes(params.cardAddress)),
            initial_log_cid: toBase64url(params.initialLogCid),
            policy_address: toBase64url(hexToBytes(params.policyAddress)),
          },
          seq
        );
        return [
          params.offerId,
          params.maxAcceptances,
          params.expiresAt,
          params.cardAddress,
          Array.from(params.initialLogCid),
          params.policyAddress,
          pressAddress,
          Array.from(payloadBytes),
          Array.from(pressSignature),
        ];
      },
      params.policyAddress
    );
  }

  async function registerSubCard(params: RegisterSubCardParams): Promise<Hex> {
    params = {
      ...params,
      subCardAddress: normalizeHex(params.subCardAddress),
      masterCardAddress: normalizeHex(params.masterCardAddress),
    };
    // Sub-card registration uses the master card's policy. Look it up.
    const masterEntry = await getCardEntry(params.masterCardAddress);
    const policyAddress = masterEntry.policy_address;
    const adminSecpPayload = params.adminSecpPayload ?? new Uint8Array(0);
    const adminSecpSignature = params.adminSecpSignature ?? ZERO_ADMIN_SECP_SIGNATURE;

    return submitWithRetry(
      'registerSubCard',
      (seq) => {
        const { payloadBytes, pressSignature } = buildAndSignPayload(
          'register_sub_card',
          {
            sub_card_address: toBase64url(hexToBytes(params.subCardAddress)),
            master_card_address: toBase64url(hexToBytes(params.masterCardAddress)),
            registration_log_head: toBase64url(params.registrationLogHead),
            sub_card_doc_cid: toBase64url(params.subCardDocCid),
          },
          seq
        );
        return [
          params.subCardAddress,
          params.masterCardAddress,
          Array.from(params.registrationLogHead),
          Array.from(params.subCardDocCid),
          pressAddress,
          Array.from(payloadBytes),
          Array.from(pressSignature),
          Array.from(params.masterSigPayload),
          Array.from(params.masterSignature),
          Array.from(adminSecpPayload),
          Array.from(adminSecpSignature),
        ];
      },
      policyAddress
    );
  }

  async function deregisterSubCard(params: DeregisterSubCardParams): Promise<Hex> {
    params = { ...params, subCardAddress: normalizeHex(params.subCardAddress) };
    const subEntry = await getSubCardEntry(params.subCardAddress);
    const masterEntry = await getCardEntry(subEntry.master_card_address);
    const policyAddress = masterEntry.policy_address;

    return submitWithRetry(
      'deregisterSubCard',
      (seq) => {
        const { payloadBytes, pressSignature } = buildAndSignPayload(
          'deregister_sub_card',
          {
            sub_card_address: toBase64url(hexToBytes(params.subCardAddress)),
          },
          seq
        );
        return [
          params.subCardAddress,
          pressAddress,
          Array.from(payloadBytes),
          Array.from(pressSignature),
          Array.from(params.sigPayload),
          Array.from(params.signature),
        ];
      },
      policyAddress
    );
  }

  async function batchUpdateCardHeads(params: BatchUpdateParams): Promise<Hex> {
    if (params.updates.length === 0 || params.updates.length > config.MAX_BATCH_SIZE) {
      throw new Error(
        `BatchUpdateCardHeads: update count ${params.updates.length} out of range [1, ${config.MAX_BATCH_SIZE}]`
      );
    }
    params = {
      policyAddress: normalizeHex(params.policyAddress),
      updates: params.updates.map((u) => ({ ...u, card_address: normalizeHex(u.card_address) })),
    };
    return submitWithRetry(
      'batchUpdateCardHeads',
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
          seq
        );
        return [
          params.policyAddress,
          pressAddress,
          params.updates.map((u) => u.card_address),
          params.updates.map((u) => Array.from(u.prev_log_cid)),
          params.updates.map((u) => Array.from(u.new_log_cid)),
          Array.from(payloadBytes),
          Array.from(pressSignature),
        ];
      },
      params.policyAddress
    );
  }

  async function getPressEthBalance(): Promise<bigint> {
    return publicClient.getBalance({ address: gasAccount.address });
  }

  async function estimateGas(functionName: string, args: unknown[]): Promise<bigint> {
    return publicClient.estimateContractGas({
      address: logicAddress,
      abi: LOGIC_ABI,
      functionName: functionName as never,
      args: args as never,
      account: gasAccount,
    });
  }

  return {
    pressGasAddress: pressAddress,
    getCardEntry,
    getPressAuthorization: (policyAddress, forPressAddress) =>
      getPressAuthorization(policyAddress, forPressAddress),
    getNextSequence,
    getOpenOfferUseCount,
    getSubCardEntry,
    getProtocolVersion,
    getCardEventLog,
    isPolicyAuthorizer,
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

/**
 * Card/policy/press addresses arriving at this client's public interface
 * may be unprefixed lowercase hex — the convention used throughout the
 * offer/verifier layer (app-sdk's `keccak256()`, `CardVerifier`,
 * wallet-sdk's `offerVerification.ts`, all of which compare addresses
 * directly against `keccak256()`'s own bare-hex output with no `0x`).
 * viem's ABI encoder requires a leading `0x` on every `Hex` arg, so every
 * exported `RegistryClient` method normalizes its own Hex-typed params
 * here before any internal call — this is the *only* place in press that
 * should add or assume a prefix; comparison/verification logic elsewhere
 * (`functions/issuance.ts`, `handlers/sub-card.ts`, etc.) works in the
 * unprefixed convention to match the rest of the system.
 */
function normalizeHex(hex: string): Hex {
  return (hex.startsWith('0x') ? hex : '0x' + hex) as Hex;
}

function hexToBytes(hex: Hex): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
