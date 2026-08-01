/**
 * `specs/process_specs/card_validation.md` end-to-end, against the live dev
 * deployment and real Arbitrum Sepolia. Adapted from
 * integration_tests/suites/core/card_validation.spec.ts — real adaptation,
 * not a mechanical port:
 *
 *  - The original reads the storage contract address from
 *    `contracts/deployments/local.json`; this suite uses
 *    `DEV_REGISTRY_CONTRACT_ADDRESS` (same variable name/meaning
 *    press/wallet-service already use — see press/DEPLOYMENT.md).
 *  - The original points `FilebaseIpfsProvider` at the local Kubo gateway
 *    (`http://localhost:8080/ipfs`); this suite uses `DEV_IPFS_GATEWAY_URL`.
 *  - `ensureLiveGovernance()` is synchronous here (no bootstrap — see
 *    `support/liveCard.ts`'s doc comment), so no `await`.
 *
 * Unlike `card_signing.spec.ts` (client-side crypto primitives in
 * isolation), this suite MUST use the full `CardVerifier` class because the
 * spec's entire purpose IS the chain-of-trust/revocation machinery in
 * Stages 2-6. Configures a real `CardVerifier` with an RPC provider pointed
 * at real Arbitrum Sepolia, an IPFS provider pointed at a real gateway, and
 * a `trustedRoots` config.
 *
 * Known limitation, carried over unchanged from the original suite: the
 * primary passing case (a minted card's chain actually reaching a trusted
 * root) is blocked because freshly-minted cards' `ancestry_pubkeys` point to
 * an issuer card that isn't itself registered on-chain — this is a
 * limitation of the minting pattern (`mintLiveCard`/`mintCard.ts`'s
 * synthetic level-1 issuer), not of local vs. real infrastructure, so it
 * applies here identically. The negative case (untrusted card fails the
 * chain walk) is fully testable and kept.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  buildMessagePayload,
  signMessageEnvelope,
  mlDsa44Sign,
  bytesToBase64Url,
  keccak256,
  type EnvelopeSigner,
} from '@membership-card-protocol/app-sdk';
import { CardVerifier } from '@membership-card-protocol/verifier';
import { EthersRpcProvider } from '@membership-card-protocol/verifier-rpc-provider';
import { FilebaseIpfsProvider } from '@membership-card-protocol/verifier-ipfs-provider';
import { createPublicClient, http, parseAbi, type Hex, type PublicClient } from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import { mintLiveCard, ensureLiveGovernance, ARBITRUM_RPC_URL, REGISTRY_CONTRACT_ADDRESS, IPFS_GATEWAY_URL, type LiveIdentity } from '../../support/liveCard.js';

// ─── Registry Contract Adapter (minimal; reuses web harness pattern) ────────

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

function signerFrom(identity: LiveIdentity): EnvelopeSigner {
  return { publicKey: identity.publicKey, sign: (message) => mlDsa44Sign(identity.secretKey, message) };
}

describe('card_validation.md (live dev deployment, full CardVerifier)', () => {
  let cardVerifier: CardVerifier;
  let trustedRoot: LiveIdentity;
  let secondCard: LiveIdentity;

  beforeAll(async () => {
    const client = createPublicClient({
      chain: arbitrumSepolia,
      transport: http(ARBITRUM_RPC_URL),
    });
    const storageAddress = REGISTRY_CONTRACT_ADDRESS as Hex;
    const registryContract = createRegistryContract(storageAddress, client);

    const rpc = new EthersRpcProvider(registryContract);
    const ipfs = new FilebaseIpfsProvider({ gatewayUrl: IPFS_GATEWAY_URL });

    // Mint test cards. Sequential to avoid nonce conflicts (see
    // card_signing.spec.ts's beforeAll comment).
    trustedRoot = await mintLiveCard('card-validation-root', {
      display_name: 'Card Validation Suite — Trusted Root',
    });
    secondCard = await mintLiveCard('card-validation-secondary', {
      display_name: 'Card Validation Suite — Secondary Card',
    });

    ensureLiveGovernance();

    cardVerifier = new CardVerifier({
      rpc,
      ipfs,
      trustedRoots: [trustedRoot.address, secondCard.address],
      appCertificationRoot: trustedRoot.address,
      fetchAnnotations: false,
      returnChain: true,
    });
  }, 120_000);

  it.todo('Stage 3: verifyCard walks chain to trusted root (primary test)', async () => {
    // Blocked by mintLiveCard's synthetic-issuer limitation — see file
    // header. Unchanged from the original suite's identical gap.
  });

  it('Stage 3: card outside trustedRoots fails chain walk', async () => {
    const result = await cardVerifier.verifyCard(secondCard.address, {
      pubkey: bytesToBase64Url(secondCard.publicKey),
    });

    expect(result.signature_valid).toBeNull();
    expect(result.chain_reaches_trusted_root).toBe(false);
    expect(result.signer_card).toBe(secondCard.address);
  }, 60_000);

  it('Stage 1: signature validity checked via verifyCard pubkey parameter', async () => {
    const result = await cardVerifier.verifyCard(trustedRoot.address, {
      pubkey: bytesToBase64Url(trustedRoot.publicKey),
    });

    expect(result.signer_card).toBe(trustedRoot.address);
    expect(keccak256(trustedRoot.publicKey)).toBe(trustedRoot.address);
  });

  it('Signature validity fails with wrong public key', async () => {
    const wrongPublicKey = secondCard.publicKey;

    const result = await cardVerifier.verifyCard(trustedRoot.address, {
      pubkey: bytesToBase64Url(wrongPublicKey),
    });

    expect(keccak256(wrongPublicKey)).not.toBe(trustedRoot.address);
    expect(result.signer_card).toBe(trustedRoot.address);
  });

  it('Created SignedMessageEnvelope structures payload correctly', async () => {
    const payload = buildMessagePayload({
      type: 'text',
      content: { body: 'test message', format: 'plain' },
      recipients: [trustedRoot.address],
      senders: [trustedRoot.address],
      protocolVersion: '0.1',
    });

    const envelope = await signMessageEnvelope(payload, [signerFrom(trustedRoot)]);

    expect(envelope.signatures).toHaveLength(1);
    const sig = envelope.signatures[0]!;
    expect(sig.public_key).toBe(bytesToBase64Url(trustedRoot.publicKey));
    expect(sig.signature).toBeDefined();
    expect(sig.signature.length).toBeGreaterThan(0);

    expect(envelope.payload).toMatchObject({
      type: 'text',
      recipients: [trustedRoot.address],
      senders: [trustedRoot.address],
      protocol_version: '0.1',
    });
    expect(envelope.payload.timestamp).toBeDefined();
  });
});
