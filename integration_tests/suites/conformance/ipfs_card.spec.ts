/**
 * `specs/object_specs/ipfs_card.md` object-spec conformance — Phase 5 Step 5.2
 * (object-spec conformance coverage).
 *
 * Verifies the five key invariants of a card as stored on IPFS:
 *  1. Content Encryption: HKDF-SHA3-256 + AES-256-GCM
 *  2. Address Derivation: keccak256(recipient_pubkey)
 *  3. CID Validation: fetch-and-byte-compare (noted as press-internal, not independently testable)
 *  4. On-Chain Anchor Table: CardEntry fields match documented meaning
 *  5. Card Versioning: protocol_version matches contract's getProtocolVersion()
 *
 * This suite mints a real, on-chain-registered card and independently verifies
 * that the encrypted IPFS bytes can be decrypted with derived keys, and that
 * on-chain state reflects what the spec promises.
 *
 * Requires the `integration_tests` stack up (`docker compose up -d --wait
 * ipfs press` at minimum) and `contracts/deployments/local.json` to exist.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { hkdfSha3256, bytesToBase64Url, base64UrlToBytes } from '@membership-card-protocol/app-sdk';
import { keccak256 as keccak256Sdk } from '@membership-card-protocol/app-sdk';
import { createPublicClient, http, parseAbi, type Hex } from 'viem';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mintLiveCard, type LiveIdentity, ensureLiveGovernance, PRESS_BASE_URL, KUBO_API_URL, ARBITRUM_RPC_URL } from '../support/liveCard.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

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
    // Copy into fresh ArrayBuffer-backed Uint8Array (required by Web Crypto strict typing)
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

/**
 * Fetch raw (encrypted) bytes for a CID from Kubo's /api/v0/cat endpoint (POST with form data).
 */
async function fetchRawCidBytesFromKubo(cid: string): Promise<Uint8Array> {
  const form = new FormData();
  form.append('arg', cid);
  const res = await fetch(`${KUBO_API_URL.replace(/\/$/, '')}/api/v0/cat`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch CID ${cid} from Kubo: HTTP ${res.status}`);
  }
  const buffer = await res.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Create a registry contract reader for CardEntry lookups.
 */
function createRegistryContractReader(storageAddress: Hex, rpcUrl: string) {
  // Note: storage contract stores CardEntry as a tuple with named fields
  const STORAGE_ABI = parseAbi([
    'function getCardEntry(bytes32 card_address) external view returns ((uint8[] log_head_cid, bytes32 policy_address, bytes32 last_press_address, bytes32 forward_to, bool exists) r)',
  ]);

  const client = createPublicClient({
    transport: http(rpcUrl),
  });

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
      // Decode CID bytes back to string
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

/**
 * Parse the logic contract's ABI to read getProtocolVersion().
 */
function createLogicContractReader(logicAddress: Hex, rpcUrl: string) {
  const LOGIC_ABI = parseAbi([
    'function getProtocolVersion() external view returns (string)',
  ]);

  const client = createPublicClient({
    transport: http(rpcUrl),
  });

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

/**
 * Helper to verify that a fetched IPFS object is a valid JSON and parse it.
 */
function parseJsonFromBytes(bytes: Uint8Array): unknown {
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text);
}

describe('ipfs_card.md object-spec conformance (live stack)', () => {
  let card: LiveIdentity;
  let governance: Awaited<ReturnType<typeof ensureLiveGovernance>>;
  let registryReader: ReturnType<typeof createRegistryContractReader>;
  let logicReader: ReturnType<typeof createLogicContractReader>;

  beforeAll(async () => {
    // Mint a test card for all conformance checks
    card = await mintLiveCard('ipfs-card-conformance', { display_name: 'IPFS Card Conformance Suite' });

    // Set up governance for policy reads
    governance = await ensureLiveGovernance();

    // Determine contract addresses from deployment
    const deploymentFile = join(REPO_ROOT, 'contracts/deployments/local.json');
    const deployment = JSON.parse(readFileSync(deploymentFile, 'utf-8')) as {
      contracts: { storage_contract: string; logic_contract: string };
    };

    registryReader = createRegistryContractReader(deployment.contracts.storage_contract as Hex, ARBITRUM_RPC_URL);
    logicReader = createLogicContractReader(deployment.contracts.logic_contract as Hex, ARBITRUM_RPC_URL);
  }, 60_000);

  it('§2 + §3: Content Encryption — HKDF-SHA3-256 derives content_key, AES-256-GCM decrypts ciphertext', async () => {
    // Fetch the card's CID (the genesis document or most recent log entry)
    // For a freshly-minted card, card.cardCid is the genesis CardDocument CID
    const cardCid = card.cardCid;

    // Fetch raw encrypted bytes from Kubo
    const encryptedBytes = await fetchRawCidBytesFromKubo(cardCid);
    expect(encryptedBytes.length).toBeGreaterThan(12 + 16); // At minimum: 12-byte nonce + 16-byte GCM tag

    // Derive content_key using the card's recipient_pubkey (which is the card holder's public key)
    const contentKey = hkdfSha3256(card.publicKey, 'card-content-v1');
    expect(contentKey).toHaveLength(32); // AES-256 key is 32 bytes

    // Decrypt using AES-256-GCM
    const decryptedBytes = await aes256gcmDecrypt(contentKey, encryptedBytes);
    expect(decryptedBytes.length).toBeGreaterThan(0);

    // Verify decrypted content is valid JSON
    const decryptedJson = parseJsonFromBytes(decryptedBytes);
    expect(decryptedJson).toBeDefined();
    expect(typeof decryptedJson).toBe('object');

    // Verify it has expected CardDocument fields (genesis document for a fresh card)
    expect(decryptedJson).toHaveProperty('protocol_version');
    expect(decryptedJson).toHaveProperty('recipient_pubkey');
    expect(decryptedJson).toHaveProperty('issuer_signature');
    expect(decryptedJson).toHaveProperty('holder_signature');
    expect(decryptedJson).toHaveProperty('press_signature');

    // Verify the recipient_pubkey in the decrypted document matches our card's public key
    const decryptedRecipientPubkey = (decryptedJson as Record<string, unknown>).recipient_pubkey;
    expect(decryptedRecipientPubkey).toBe(bytesToBase64Url(card.publicKey));
  }, 30_000);

  it('§2: Address Derivation — keccak256(recipient_pubkey) equals on-chain card address', async () => {
    // Derive the address client-side: keccak256(recipient_pubkey)
    // Note: app-sdk's keccak256 returns a hex string
    const derivedAddressHex = keccak256Sdk(card.publicKey);

    // The card's address from mintLiveCard is already keccak256(publicKey) as a hex string
    // Both should be identical
    expect(derivedAddressHex).toBe(card.address);
  });

  it('§4: On-Chain Anchor Table — CardEntry fields match documented meaning', async () => {
    // Read the CardEntry for this card from the registry contract
    const cardEntry = await registryReader.getCardEntry(card.address);

    // §4 table: log_head_cid — CID of the most recent IPFS object (genesis for fresh card)
    expect(cardEntry.log_head_cid).toBe(card.cardCid);

    // §4 table: policy_address — on-chain address of the governing PolicyCardDocument
    expect(cardEntry.policy_address).toBeDefined();
    // For the permissive test policy, this should match the governance policy address
    const expectedPolicyAddress = governance.policyAddress;
    expect(cardEntry.policy_address.toLowerCase()).toBe(
      (expectedPolicyAddress.startsWith('0x') ? expectedPolicyAddress : '0x' + expectedPolicyAddress).toLowerCase()
    );

    // §4 table: last_press_address — on-chain address of the press that signed the most recent write
    expect(cardEntry.last_press_address).toBeDefined();
    expect(cardEntry.last_press_address).not.toBe('0x' + '0'.repeat(40)); // Not zero

    // §4 table: exists — true once RegisterCard has created the entry
    expect(cardEntry.exists).toBe(true);

    // §4 table: forward_to — only set if this card has been superseded by key rotation
    // For a fresh card with no rotation, should be bytes32 zero (no forward)
    expect(cardEntry.forward_to).toBe('0x' + '0'.repeat(64));
  }, 30_000);

  it('§7: Card Versioning — genesis protocol_version matches contract getProtocolVersion()', async () => {
    // Fetch the encrypted card from IPFS
    const encryptedBytes = await fetchRawCidBytesFromKubo(card.cardCid);

    // Decrypt to access the genesis document
    const contentKey = hkdfSha3256(card.publicKey, 'card-content-v1');
    const decryptedBytes = await aes256gcmDecrypt(contentKey, encryptedBytes);
    const cardJson = parseJsonFromBytes(decryptedBytes) as Record<string, unknown>;

    // Extract protocol_version from the genesis document
    const cardProtocolVersion = cardJson.protocol_version;
    expect(cardProtocolVersion).toBeDefined();
    expect(typeof cardProtocolVersion).toBe('string');

    // Read getProtocolVersion() from the logic contract
    const contractProtocolVersion = await logicReader.getProtocolVersion();
    expect(contractProtocolVersion).toBeDefined();

    // They should match (the press set the genesis protocol_version from the contract at mint time)
    expect(cardProtocolVersion).toBe(contractProtocolVersion);
  }, 30_000);

  it.todo('§4: CID Validation (fetch-and-byte-compare) — currently out of reach as press-internal behavior', () => {
    // This is documented in §4 as press-internal behavior (press.md §5.1's `pinToIPFS`):
    // The press validates by re-fetching the CID from Filebase and byte-comparing.
    // This is not independently testable from outside the press's own process — we can
    // verify the CID exists and resolves (done above), but not verify that the press
    // performed the fetch-and-compare round trip. Noted as an out-of-reach invariant
    // per the task spec.
  });
});
