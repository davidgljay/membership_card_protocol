/**
 * `specs/object_specs/ipfs_card.md` object-spec conformance, against the
 * live dev deployment and real Arbitrum Sepolia/IPFS. Adapted from
 * integration_tests/suites/conformance/ipfs_card.spec.ts — real adaptation,
 * not a mechanical port:
 *
 *  - The original fetches raw CID bytes via Kubo's `/api/v0/cat` RPC
 *    endpoint (a local devnode's own IPFS node). The live dev deployment's
 *    real IPFS provider is a Filebase gateway, which exposes read-only
 *    gateway access (`GET <gateway>/ipfs/<cid>`), not Kubo's admin RPC API.
 *    `fetchRawCidBytes` below uses the gateway path instead.
 *  - Contract addresses come from `DEV_REGISTRY_CONTRACT_ADDRESS` /
 *    `DEV_LOGIC_CONTRACT_ADDRESS` (not `contracts/deployments/local.json`).
 *  - `ensureLiveGovernance()` is synchronous here (no bootstrap).
 *
 * Verifies the key invariants of a card as stored on IPFS:
 *  1. Content Encryption: HKDF-SHA3-256 + AES-256-GCM
 *  2. Address Derivation: keccak256(recipient_pubkey)
 *  3. CID Validation: fetch-and-byte-compare (press-internal, not independently testable — kept as it.todo)
 *  4. On-Chain Anchor Table: CardEntry fields match documented meaning
 *  5. Card Versioning: protocol_version matches contract's getProtocolVersion()
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { hkdfSha3256, bytesToBase64Url, keccak256 as keccak256Sdk } from '@membership-card-protocol/app-sdk';
import { createPublicClient, http, parseAbi, type Hex } from 'viem';
import {
  mintLiveCard,
  type LiveIdentity,
  ensureLiveGovernance,
  ARBITRUM_RPC_URL,
  REGISTRY_CONTRACT_ADDRESS,
  LOGIC_CONTRACT_ADDRESS,
  IPFS_GATEWAY_URL,
} from '../../support/liveCard.js';

/**
 * AES-256-GCM decryption: extract nonce (first 12 bytes) and decrypt.
 * Format: 12-byte nonce || ciphertext || 16-byte GCM tag (standard Node.js layout).
 */
async function aes256gcmDecrypt(key: Uint8Array, noncePlusCiphertext: Uint8Array): Promise<Uint8Array> {
  if (noncePlusCiphertext.length < 12 + 16) {
    throw new Error('Encrypted payload too short to contain nonce and GCM tag');
  }

  const nonce = noncePlusCiphertext.subarray(0, 12);
  const ciphertextAndTag = noncePlusCiphertext.subarray(12);

  try {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      Uint8Array.from(key),
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Uint8Array.from(nonce) },
      cryptoKey,
      Uint8Array.from(ciphertextAndTag)
    );
    return new Uint8Array(plaintext);
  } catch (error) {
    throw new Error(`AES-256-GCM decryption failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Fetch raw (encrypted) bytes for a CID via the real IPFS gateway. */
async function fetchRawCidBytes(cid: string): Promise<Uint8Array> {
  const res = await fetch(`${IPFS_GATEWAY_URL.replace(/\/$/, '')}/ipfs/${cid}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch CID ${cid} from ${IPFS_GATEWAY_URL}: HTTP ${res.status}`);
  }
  const buffer = await res.arrayBuffer();
  return new Uint8Array(buffer);
}

function createRegistryContractReader(storageAddress: Hex, rpcUrl: string) {
  const STORAGE_ABI = parseAbi([
    'function getCardEntry(bytes32 card_address) external view returns ((uint8[] log_head_cid, bytes32 policy_address, bytes32 last_press_address, bytes32 forward_to, bool exists) r)',
  ]);

  const client = createPublicClient({ transport: http(rpcUrl) });

  function toHex0x(address: string): Hex {
    return (address.startsWith('0x') ? address : '0x' + address) as Hex;
  }

  return {
    async getCardEntry(address: string) {
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
      const logHeadCid = new TextDecoder().decode(Uint8Array.from(tuple.log_head_cid));
      return {
        log_head_cid: logHeadCid,
        policy_address: tuple.policy_address,
        last_press_address: tuple.last_press_address,
        exists: tuple.exists,
        forward_to: tuple.forward_to,
      };
    },
  };
}

function createLogicContractReader(logicAddress: Hex, rpcUrl: string) {
  const LOGIC_ABI = parseAbi(['function getProtocolVersion() external view returns (string)']);
  const client = createPublicClient({ transport: http(rpcUrl) });

  return {
    async getProtocolVersion(): Promise<string> {
      const result = await client.readContract({
        address: logicAddress,
        abi: LOGIC_ABI,
        functionName: 'getProtocolVersion',
      });
      return result as string;
    },
  };
}

function parseJsonFromBytes(bytes: Uint8Array): unknown {
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text);
}

describe('ipfs_card.md object-spec conformance (live dev deployment)', () => {
  let card: LiveIdentity;
  let governance: ReturnType<typeof ensureLiveGovernance>;
  let registryReader: ReturnType<typeof createRegistryContractReader>;
  let logicReader: ReturnType<typeof createLogicContractReader>;

  beforeAll(async () => {
    card = await mintLiveCard('ipfs-card-conformance', { display_name: 'IPFS Card Conformance Suite' });
    governance = ensureLiveGovernance();

    registryReader = createRegistryContractReader(REGISTRY_CONTRACT_ADDRESS as Hex, ARBITRUM_RPC_URL);
    logicReader = createLogicContractReader(LOGIC_CONTRACT_ADDRESS as Hex, ARBITRUM_RPC_URL);
  }, 60_000);

  it('§2 + §3: Content Encryption — HKDF-SHA3-256 derives content_key, AES-256-GCM decrypts ciphertext', async () => {
    const cardCid = card.cardCid;

    const encryptedBytes = await fetchRawCidBytes(cardCid);
    expect(encryptedBytes.length).toBeGreaterThan(12 + 16);

    const contentKey = hkdfSha3256(card.publicKey, 'card-content-v1');
    expect(contentKey).toHaveLength(32);

    const decryptedBytes = await aes256gcmDecrypt(contentKey, encryptedBytes);
    expect(decryptedBytes.length).toBeGreaterThan(0);

    const decryptedJson = parseJsonFromBytes(decryptedBytes);
    expect(decryptedJson).toBeDefined();
    expect(typeof decryptedJson).toBe('object');

    expect(decryptedJson).toHaveProperty('protocol_version');
    expect(decryptedJson).toHaveProperty('recipient_pubkey');
    expect(decryptedJson).toHaveProperty('issuer_signature');
    expect(decryptedJson).toHaveProperty('holder_signature');
    expect(decryptedJson).toHaveProperty('press_signature');

    const decryptedRecipientPubkey = (decryptedJson as Record<string, unknown>).recipient_pubkey;
    expect(decryptedRecipientPubkey).toBe(bytesToBase64Url(card.publicKey));
  }, 30_000);

  it('§2: Address Derivation — keccak256(recipient_pubkey) equals on-chain card address', async () => {
    const derivedAddressHex = keccak256Sdk(card.publicKey);
    expect(derivedAddressHex).toBe(card.address);
  });

  it('§4: On-Chain Anchor Table — CardEntry fields match documented meaning', async () => {
    const cardEntry = await registryReader.getCardEntry(card.address);

    expect(cardEntry.log_head_cid).toBe(card.cardCid);

    expect(cardEntry.policy_address).toBeDefined();
    const expectedPolicyAddress = governance.policyAddress;
    expect(cardEntry.policy_address.toLowerCase()).toBe(
      (expectedPolicyAddress.startsWith('0x') ? expectedPolicyAddress : '0x' + expectedPolicyAddress).toLowerCase()
    );

    expect(cardEntry.last_press_address).toBeDefined();
    expect(cardEntry.last_press_address).not.toBe('0x' + '0'.repeat(40));

    expect(cardEntry.exists).toBe(true);

    expect(cardEntry.forward_to).toBe('0x' + '0'.repeat(64));
  }, 30_000);

  it('§7: Card Versioning — genesis protocol_version matches contract getProtocolVersion()', async () => {
    const encryptedBytes = await fetchRawCidBytes(card.cardCid);

    const contentKey = hkdfSha3256(card.publicKey, 'card-content-v1');
    const decryptedBytes = await aes256gcmDecrypt(contentKey, encryptedBytes);
    const cardJson = parseJsonFromBytes(decryptedBytes) as Record<string, unknown>;

    const cardProtocolVersion = cardJson.protocol_version;
    expect(cardProtocolVersion).toBeDefined();
    expect(typeof cardProtocolVersion).toBe('string');

    const contractProtocolVersion = await logicReader.getProtocolVersion();
    expect(contractProtocolVersion).toBeDefined();

    expect(cardProtocolVersion).toBe(contractProtocolVersion);
  }, 30_000);

  it.todo('§4: CID Validation (fetch-and-byte-compare) — currently out of reach as press-internal behavior', () => {
    // Press-internal (press.md §5.1's pinToIPFS): not independently testable
    // from outside the press's own process. Unchanged from the original suite.
  });
});
