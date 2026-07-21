/**
 * Browser-safe `RegistryContract` adapter for
 * `@membership-card-protocol/verifier-rpc-provider`'s `EthersRpcProvider`
 * (the name is legacy — the interface it wraps has nothing ethers.js-
 * specific, any implementation satisfies it). Built on `viem` rather than
 * ethers, reusing the exact ABI corrections press's own `chain/registry.ts`
 * required (see `integration_tests/reports/phase-1-environment-notes.md`'s
 * "Press's chain integration" entry for the full story):
 *
 * - Function names are camelCase (Stylus SDK's real ABI dispatch), not the
 *   Rust source's snake_case.
 * - Every `Vec<u8>` is `uint8[]`, not `bytes`.
 * - Reads go to the **storage** contract, not logic — some reads
 *   (`getSubCardEntry`) exist only there.
 * - Multi-value returns containing a `uint8[]` need the return declared as
 *   a single named tuple, or viem's decoder throws `PositionOutOfBoundsError`.
 */

import { createPublicClient, http, parseAbi, type Hex, type PublicClient } from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import type { RegistryContract } from '@membership-card-protocol/verifier-rpc-provider';

const STORAGE_ABI = parseAbi([
  'function getCardEntry(bytes32 card_address) external view returns ((uint8[] log_head_cid, bytes32 policy_address, bytes32 last_press_address, bytes32 forward_to, bool exists) r)',
  'function isPressActive(bytes32 policy_address, bytes32 press_address) external view returns (bool)',
  'function getPressAuthorization(bytes32 policy_address, bytes32 press_address) external view returns ((uint8[] press_public_key, bytes32 mldsa44_key_hash, uint8 key_scheme, bool active, uint64 next_sequence, uint64 authorized_at, uint64 revoked_at) r)',
  'function getSubCardEntry(bytes32 sub_card_address) external view returns ((bytes32 master_card_address, uint8[] registration_log_head, uint8[] sub_card_doc_cid, bool active, uint64 registered_at, uint64 deregistered_at) r)',
]);

export interface ViemRegistryContractOptions {
  rpcUrl: string;
  storageAddress: Hex;
}

const ZERO_BYTES32 = '0x' + '00'.repeat(32);

/**
 * Card addresses flowing through the offer/verifier layer (wallet-sdk's
 * `offerVerification.ts`, `CardVerifier`) are unprefixed lowercase hex —
 * they're compared directly against `keccak256()`'s own bare-hex output.
 * viem's ABI encoder requires a leading `0x` on every `Hex` arg, so this
 * adapter — the only piece of this harness that actually talks to the
 * chain — re-adds the prefix defensively rather than assuming callers do.
 */
function toHex0x(address: string): Hex {
  return (address.startsWith('0x') ? address : '0x' + address) as Hex;
}

function toHexString(bytes: readonly number[]): string {
  return '0x' + Uint8Array.from(bytes).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
}

/**
 * CID fields (`log_head_cid`, `registration_log_head`, `sub_card_doc_cid`)
 * are stored on-chain as UTF-8-encoded CID text (`new TextEncoder().encode(
 * cardCid)`, matching press's own `registry.ts` convention) — decode back
 * to the CID string, not hex.
 */
function toCidString(bytes: readonly number[]): string {
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/** viem-based `RegistryContract` — see file doc. */
export function createViemRegistryContract(options: ViemRegistryContractOptions): RegistryContract {
  const client: PublicClient = createPublicClient({
    chain: arbitrumSepolia,
    transport: http(options.rpcUrl),
  });
  const storageAddress = options.storageAddress;

  return {
    async getCardEntry(address) {
      const result = await client.readContract({
        address: storageAddress,
        abi: STORAGE_ABI,
        functionName: 'getCardEntry',
        args: [toHex0x(address)],
      });
      const tuple = result as unknown as {
        log_head_cid: readonly number[];
        policy_address: Hex;
        last_press_address: Hex;
        forward_to: Hex;
        exists: boolean;
      };
      return {
        log_head_cid: toCidString(tuple.log_head_cid),
        policy_address: tuple.policy_address,
        last_press_address: tuple.last_press_address,
        forward_to: tuple.forward_to === ZERO_BYTES32 ? null : tuple.forward_to,
        exists: tuple.exists,
      };
    },

    async isPolicyAuthorizer() {
      // No policy-authorizer concept exercised by this harness's scenario
      // (the "root" card is recognized via CardVerifier's trustedRoots
      // config, not this path) — see scenario.ts's doc comment.
      return false;
    },

    async getPressAuthorization(policyAddress, pressAddress) {
      const result = await client.readContract({
        address: storageAddress,
        abi: STORAGE_ABI,
        functionName: 'getPressAuthorization',
        args: [toHex0x(policyAddress), toHex0x(pressAddress)],
      });
      const tuple = result as unknown as {
        press_public_key: readonly number[];
        mldsa44_key_hash: Hex;
        active: boolean;
        authorized_at: bigint;
        revoked_at: bigint;
      };
      if (!tuple.active && tuple.authorized_at === 0n) return null;
      return {
        press_public_key: toHexString(tuple.press_public_key),
        mldsa44_key_hash: tuple.mldsa44_key_hash,
        active: tuple.active,
        authorized_at: String(tuple.authorized_at),
        revoked_at: tuple.revoked_at === 0n ? null : String(tuple.revoked_at),
      };
    },

    async getSubCardEntry(subCardAddress) {
      const result = await client.readContract({
        address: storageAddress,
        abi: STORAGE_ABI,
        functionName: 'getSubCardEntry',
        args: [toHex0x(subCardAddress)],
      });
      const tuple = result as unknown as {
        master_card_address: Hex;
        registration_log_head: readonly number[];
        sub_card_doc_cid: readonly number[];
        active: boolean;
        registered_at: bigint;
        deregistered_at: bigint;
      };
      if (tuple.master_card_address === ZERO_BYTES32) return null;
      return {
        master_card_address: tuple.master_card_address,
        registration_log_head: toCidString(tuple.registration_log_head),
        sub_card_doc_cid: toCidString(tuple.sub_card_doc_cid),
        active: tuple.active,
        registered_at: String(tuple.registered_at),
        deregistered_at: tuple.deregistered_at === 0n ? null : String(tuple.deregistered_at),
      };
    },

    async getCardEventLog() {
      // Not exercised by this harness's scenario (no update/revocation
      // history walk needed for a freshly-minted card) — see scenario.ts.
      return [];
    },

    async getEasAnnotations() {
      // CardVerifier is constructed with fetchAnnotations: false; this is
      // never called.
      return [];
    },
  };
}
