/**
 * `specs/object_specs/card_verifier.md` object-spec conformance, against
 * the live dev deployment and real Arbitrum Sepolia. Adapted from
 * integration_tests/suites/conformance/card_verifier.spec.ts — real
 * adaptation, not a mechanical port: the storage contract address comes
 * from `DEV_REGISTRY_CONTRACT_ADDRESS` (not `contracts/deployments/local.json`)
 * and the IPFS gateway from `DEV_IPFS_GATEWAY_URL` (not a hardcoded local
 * Kubo gateway).
 *
 * Per this directory's coverage map, scope is deliberately narrower than
 * "test every stage" — inherited from `core/card_validation.spec.ts`'s
 * same chain-of-trust/ancestry gap (freshly-minted test cards' ancestry
 * points at an issuer never itself registered on-chain, so any chain walk
 * that needs to reach a trusted root fails). This suite designs around
 * that gap rather than re-litigating it:
 *
 *  1. §6.2 verifyCard's documented result shape for a genuinely
 *     nonexistent card address (never registered on-chain at all).
 *  2. §5 Configuration — constructor-time validation of required
 *     rpc/ipfs providers. No live-stack dependency.
 *  3. §8 Result Types — chain_card_addresses/chain shape on the not-found path.
 *  4. §6.1 verifyEnvelope's protocol-version rejection path — no network I/O.
 */

import { describe, it, expect } from 'vitest';
import { type SignedMessageEnvelope } from '@membership-card-protocol/app-sdk';
import { CardVerifier, CardProtocolError } from '@membership-card-protocol/verifier';
import { EthersRpcProvider } from '@membership-card-protocol/verifier-rpc-provider';
import { FilebaseIpfsProvider } from '@membership-card-protocol/verifier-ipfs-provider';
import { createPublicClient, http, parseAbi, type Hex, type PublicClient } from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import { ARBITRUM_RPC_URL, REGISTRY_CONTRACT_ADDRESS, IPFS_GATEWAY_URL } from '../../support/liveCard.js';

// ─── Registry Contract Adapter (mirrors core/card_validation.spec.ts's pattern) ──

interface RegistryContract {
  getCardEntry(address: string): Promise<{
    log_head_cid: string;
    policy_address: string;
    last_press_address: string;
    forward_to: string | null;
    exists: boolean;
  }>;
  isPolicyAuthorizer(address: string): Promise<boolean>;
  getPressAuthorization(policyAddress: string, pressAddress: string): Promise<{
    press_public_key: string;
    mldsa44_key_hash: string;
    active: boolean;
    authorized_at: string;
    revoked_at: string | null;
  } | null>;
  getSubCardEntry(subCardAddress: string): Promise<{
    master_card_address: string;
    registration_log_head: string;
    sub_card_doc_cid: string;
    active: boolean;
    registered_at: string;
    deregistered_at: string | null;
  } | null>;
  getCardEventLog(cardAddress: string): Promise<Array<{
    cid: string;
    timestamp: string;
  }>>;
  getEasAnnotations(cardAddress: string, annotatorAddresses: string[]): Promise<Array<{
    uid: string;
    attester: string;
    cid: string;
    update_code: number;
    effective_date: string;
  }>>;
}

const STORAGE_ABI = parseAbi([
  'function getCardEntry(bytes32 card_address) external view returns ((uint8[] log_head_cid, bytes32 policy_address, bytes32 last_press_address, bytes32 forward_to, bool exists) r)',
  'function isPressActive(bytes32 policy_address, bytes32 press_address) external view returns (bool)',
  'function getPressAuthorization(bytes32 policy_address, bytes32 press_address) external view returns ((uint8[] press_public_key, bytes32 mldsa44_key_hash, uint8 key_scheme, bool active, uint64 next_sequence, uint64 authorized_at, uint64 revoked_at) r)',
  'function getSubCardEntry(bytes32 sub_card_address) external view returns ((bytes32 master_card_address, uint8[] registration_log_head, uint8[] sub_card_doc_cid, bool active, uint64 registered_at, uint64 deregistered_at) r)',
]);

const ZERO_BYTES32 = '0x' + '00'.repeat(32);

function toHex0x(address: string): Hex {
  return (address.startsWith('0x') ? address : '0x' + address) as Hex;
}

function toHexString(bytes: readonly number[]): string {
  return '0x' + Uint8Array.from(bytes).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
}

function toCidString(bytes: readonly number[]): string {
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function createRegistryContract(storageAddress: Hex, client: PublicClient): RegistryContract {
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
      return [];
    },

    async getEasAnnotations() {
      return [];
    },
  };
}

function buildRealVerifier(overrides?: Partial<{ trustedRoots: string[] }>): CardVerifier {
  const client = createPublicClient({
    chain: arbitrumSepolia,
    transport: http(ARBITRUM_RPC_URL),
  });
  const storageAddress = REGISTRY_CONTRACT_ADDRESS as Hex;
  const registryContract = createRegistryContract(storageAddress, client);
  const rpc = new EthersRpcProvider(registryContract);
  const ipfs = new FilebaseIpfsProvider({ gatewayUrl: IPFS_GATEWAY_URL });

  return new CardVerifier({
    rpc,
    ipfs,
    trustedRoots: overrides?.trustedRoots ?? [],
    fetchAnnotations: false,
    returnChain: true,
  });
}

// A syntactically valid but never-registered on-chain address (32 bytes hex,
// deterministic so failures are reproducible, distinguishable from any real
// keccak256(pubkey) output by construction).
const NEVER_REGISTERED_ADDRESS = '0x' + 'ab'.repeat(32);

describe('card_verifier.md object-spec conformance (live dev deployment)', () => {
  describe('§5 Configuration: constructor validation', () => {
    it('§5: constructing without rpc throws MISSING_RPC_PROVIDER', () => {
      const ipfs = new FilebaseIpfsProvider({ gatewayUrl: IPFS_GATEWAY_URL });
      let caught: unknown;
      try {
        // @ts-expect-error — intentionally omitting the required `rpc` field to
        // confirm the constructor-time rejection the spec documents.
        new CardVerifier({ ipfs });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(CardProtocolError);
      expect((caught as CardProtocolError).code).toBe('MISSING_RPC_PROVIDER');
    });

    it('§5: constructing without ipfs throws MISSING_IPFS_PROVIDER', () => {
      const client = createPublicClient({ chain: arbitrumSepolia, transport: http(ARBITRUM_RPC_URL) });
      const storageAddress = REGISTRY_CONTRACT_ADDRESS as Hex;
      const rpc = new EthersRpcProvider(createRegistryContract(storageAddress, client));
      let caught: unknown;
      try {
        // @ts-expect-error — intentionally omitting the required `ipfs` field.
        new CardVerifier({ rpc });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(CardProtocolError);
      expect((caught as CardProtocolError).code).toBe('MISSING_IPFS_PROVIDER');
    });

    it('§5: appCertificationRoot is genuinely optional at construction (no throw)', () => {
      expect(() => buildRealVerifier()).not.toThrow();
    });

    it.todo(
      'Stage 2 step 16: sub-card signature on a verifier without appCertificationRoot ' +
        'hard-rejects with APP_CERTIFICATION_ROOT_NOT_CONFIGURED',
      () => {
        // BLOCKED for the same reason core/card_validation.spec.ts's Stage 3
        // chain-walk test is blocked — see this file's header comment.
      }
    );
  });

  describe('§6.2 verifyCard: not-found path', () => {
    it('§6.2 + §8: a never-registered address produces the documented skipped-sentinel result', async () => {
      const verifier = buildRealVerifier();
      const result = await verifier.verifyCard(NEVER_REGISTERED_ADDRESS);

      expect(result.signature_valid).toBeNull();
      expect(result.scope_clean).toBe('skipped');
      expect(result.app_card_chain_valid).toBe('skipped');
      expect(result.chain_reaches_trusted_root).toBe('skipped');
      expect(result.revocation.status).toBe('unknown');
      expect(result.revocation.code).toBeNull();
      expect(result.revocation.effective_date).toBeNull();
      expect(result.was_valid_at_signing_time).toBe('skipped');
      expect(result.is_currently_valid).toBe('skipped');
      expect(result.log_updates).toEqual([]);
      expect(result.policy_compliant).toBe('skipped');
      expect(result.policy_match).toBeNull();
      expect(result.press_subsequently_revoked).toBe(false);
      expect(result.non_compliance_reported).toBe(false);
      expect(result.addressed_to_verifier).toBe(false);
      expect(result.annotations).toEqual([]);

      expect(result.signer_card).toBe(NEVER_REGISTERED_ADDRESS);
      expect(result.protocol_version).toBeTruthy();

      expect(result.errors).toContainEqual(
        expect.objectContaining({ stage: 2, code: 'CARD_NOT_FOUND' })
      );
    }, 30_000);

    it('§8: chain_card_addresses/chain are present (not undefined) even on the not-found path', async () => {
      const verifier = buildRealVerifier();
      const result = await verifier.verifyCard(NEVER_REGISTERED_ADDRESS);

      expect(result.chain_card_addresses).toBeDefined();
      expect(Array.isArray(result.chain_card_addresses)).toBe(true);
      expect(result.chain_card_addresses).toEqual([]);

      expect(result.chain).toBeDefined();
      expect(Array.isArray(result.chain)).toBe(true);
      expect(result.chain).toEqual([]);
    }, 30_000);

    it('§6.2: the same not-found result is stable across repeated calls (no hidden state)', async () => {
      const verifier = buildRealVerifier();
      const first = await verifier.verifyCard(NEVER_REGISTERED_ADDRESS);
      const second = await verifier.verifyCard(NEVER_REGISTERED_ADDRESS);
      expect(second.scope_clean).toBe(first.scope_clean);
      expect(second.errors).toEqual(first.errors);
    }, 30_000);
  });

  describe('§6.1 verifyEnvelope: protocol-version rejection path', () => {
    it('§6.1: missing protocol_version produces the documented early-return shape', async () => {
      const verifier = buildRealVerifier();
      const envelope = {
        payload: {
          message: 'test',
          timestamp: new Date().toISOString(),
        },
        signatures: [
          {
            public_key: 'not-checked-on-this-path',
            signature: 'not-checked-on-this-path',
          },
        ],
      } as unknown as SignedMessageEnvelope;

      const result = await verifier.verifyEnvelope(envelope);

      expect(result.protocol_version).toBe('unknown');
      expect(result.envelope_id).toBe('');
      expect(result.signatures).toHaveLength(1);

      const sig = result.signatures[0]!;
      expect(sig.signer_card).toBe('');
      expect(sig.signature_valid).toBe(false);
      expect(sig.scope_clean).toBe('skipped');
      expect(sig.chain_reaches_trusted_root).toBe('skipped');
      expect(sig.chain_card_addresses).toEqual([]);
      expect(sig.app_card_chain_valid).toBe('skipped');
      expect(sig.revocation.status).toBe('unknown');
      expect(sig.was_valid_at_signing_time).toBe('skipped');
      expect(sig.is_currently_valid).toBe('skipped');
      expect(sig.log_updates).toEqual([]);
      expect(sig.policy_compliant).toBe('skipped');
      expect(sig.policy_match).toBeNull();
      expect(sig.press_subsequently_revoked).toBe(false);
      expect(sig.non_compliance_reported).toBe(false);
      expect(sig.addressed_to_verifier).toBe(false);
      expect(sig.annotations).toEqual([]);
      expect(sig.chain).toEqual([]);

      expect(sig.errors).toContainEqual(
        expect.objectContaining({ stage: 1, code: 'MISSING_PROTOCOL_VERSION' })
      );
    });

    it('§6.1: unknown (non-empty) protocol_version is rejected with the same early-return shape', async () => {
      const verifier = buildRealVerifier();
      const envelope = {
        payload: {
          message: 'test',
          timestamp: new Date().toISOString(),
          protocol_version: '99.9',
        },
        signatures: [
          { public_key: 'not-checked-on-this-path', signature: 'not-checked-on-this-path' },
        ],
      } as unknown as SignedMessageEnvelope;

      const result = await verifier.verifyEnvelope(envelope);

      expect(result.protocol_version).toBe('99.9');
      expect(result.signatures).toHaveLength(1);
      expect(result.signatures[0]!.errors).toContainEqual(
        expect.objectContaining({ stage: 1, code: 'UNKNOWN_PROTOCOL_VERSION' })
      );
    });

    it('§6.1: this rejection needs no network access (verified against an unreachable host)', async () => {
      const unreachableRpc = new EthersRpcProvider(
        createRegistryContract(
          '0x0000000000000000000000000000000000dEaD' as Hex,
          createPublicClient({ chain: arbitrumSepolia, transport: http('http://127.0.0.1:1') })
        )
      );
      const unreachableIpfs = new FilebaseIpfsProvider({ gatewayUrl: 'http://127.0.0.1:1/ipfs' });
      const verifier = new CardVerifier({ rpc: unreachableRpc, ipfs: unreachableIpfs });

      const envelope = {
        payload: { message: 'test', timestamp: new Date().toISOString() },
        signatures: [{ public_key: 'x', signature: 'y' }],
      } as unknown as SignedMessageEnvelope;

      const result = await verifier.verifyEnvelope(envelope);
      expect(result.signatures[0]!.errors[0]!.code).toBe('MISSING_PROTOCOL_VERSION');
    });
  });

  describe('Stage 3+ chain walks (NOT TESTABLE in this environment)', () => {
    it.todo(
      'Full verifyCard/verifyEnvelope chain walk to a trusted root for a real minted card',
      () => {
        // CONFIRMED BLOCKED — same root cause core/card_validation.spec.ts
        // documents: a live-minted card's ancestry_pubkeys points at an
        // issuer never itself registered on-chain, so the walk fails with
        // "Ancestor card not found" rather than reaching a trusted root.
      }
    );
  });
});
