import { describe, it, expect, vi } from 'vitest';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { keccak_256 } from '@noble/hashes/sha3';
import {
  verifyUuidRegistrationEnvelope,
  resolveSubcardPubkey,
  type UuidRegistrationEnvelope,
  type UuidRegistrationPayload,
} from '../src/auth/subcard-uuid-signature.js';
import { canonicalize } from '../src/canonicalize.js';
import type { WalletServiceConfig } from '../src/config.js';
import type { Hex } from 'viem';
import type { SubcardRegistryClient, SubCardEntry } from '../src/chain/subcard-registry.js';

const CONFIG = {
  IPFS_GATEWAY_URL: 'https://ipfs.example.test',
} as unknown as WalletServiceConfig;

function subcardKeys() {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const keys = ml_dsa44.keygen(seed);
  const subcardHash = '0x' + Buffer.from(keccak_256(keys.publicKey)).toString('hex');
  const pubkeyB64 = Buffer.from(keys.publicKey).toString('base64url');
  return { ...keys, subcardHash, pubkeyB64 };
}

function makeRegistryClient(entry: Partial<SubCardEntry> & { sub_card_doc_cid: Uint8Array }): SubcardRegistryClient {
  return {
    getSubCardEntry: vi.fn().mockResolvedValue({
      master_card_address: ('0x' + '11'.repeat(32)) as Hex,
      registration_log_head: new Uint8Array(),
      active: true,
      registered_at: 0n,
      deregistered_at: 0n,
      ...entry,
    } satisfies SubCardEntry),
  };
}

function mockIpfsFetch(pubkeyB64: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ recipient_pubkey: pubkeyB64 }),
    })
  );
}

function buildPayload(overrides: Partial<UuidRegistrationPayload> = {}): UuidRegistrationPayload {
  return {
    card_hash: '0x' + 'aa'.repeat(32),
    subcard_hash: '0x' + 'bb'.repeat(32),
    uuids: [crypto.randomUUID()],
    timestamp: new Date().toISOString(),
    nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
    ...overrides,
  };
}

function sign(payload: UuidRegistrationPayload, secretKey: Uint8Array): string {
  const sig = ml_dsa44.sign(canonicalize(payload), secretKey);
  return Buffer.from(sig).toString('base64url');
}

describe('resolveSubcardPubkey', () => {
  it('resolves recipient_pubkey via registry -> IPFS', async () => {
    const sc = subcardKeys();
    const cid = new TextEncoder().encode('bafyTestCid');
    const registryClient = makeRegistryClient({ sub_card_doc_cid: cid });
    mockIpfsFetch(sc.pubkeyB64);

    const result = await resolveSubcardPubkey(CONFIG, sc.subcardHash, registryClient);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pubkeyB64).toBe(sc.pubkeyB64);
    }
    vi.unstubAllGlobals();
  });

  it('resolves an on-chain-deregistered (inactive) sub-card just like an active one -- resolution does not gate on SubCardEntry.active', async () => {
    // Correction to ea7ce3b1: on-chain `active` is a cryptographic
    // revocation flag (subcard_creation_policy.md's 8xx/9xx flow), not a
    // proxy for wallet-service-local UUID-pool bookkeeping. A subcard
    // that is inactive on-chain must still be able to resolve its pubkey
    // (and, at the route-handler layer, still be able to register/
    // deregister UUIDs given a valid signature) -- see resolveSubcardPubkey's
    // doc comment in src/auth/subcard-uuid-signature.ts.
    const sc = subcardKeys();
    const cid = new TextEncoder().encode('bafyTestCid');
    const registryClient = makeRegistryClient({ sub_card_doc_cid: cid, active: false });
    mockIpfsFetch(sc.pubkeyB64);

    const result = await resolveSubcardPubkey(CONFIG, sc.subcardHash, registryClient);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pubkeyB64).toBe(sc.pubkeyB64);
    }
    vi.unstubAllGlobals();
  });

  it('surfaces on-chain lookup failures', async () => {
    const registryClient: SubcardRegistryClient = {
      getSubCardEntry: vi.fn().mockRejectedValue(new Error('RPC unreachable')),
    };
    const result = await resolveSubcardPubkey(CONFIG, '0x' + 'cc'.repeat(32), registryClient);
    expect(result.ok).toBe(false);
  });
});

describe('verifyUuidRegistrationEnvelope', () => {
  it('accepts a validly signed envelope', async () => {
    const sc = subcardKeys();
    const cid = new TextEncoder().encode('bafyTestCid');
    const registryClient = makeRegistryClient({ sub_card_doc_cid: cid });
    mockIpfsFetch(sc.pubkeyB64);

    const payload = buildPayload({ subcard_hash: sc.subcardHash });
    const envelope: UuidRegistrationEnvelope = { payload, signature: sign(payload, sc.secretKey) };

    const result = await verifyUuidRegistrationEnvelope(CONFIG, envelope, registryClient);
    expect(result.ok).toBe(true);
    vi.unstubAllGlobals();
  });

  it('accepts a validly signed envelope for a sub-card that is inactive (deregistered) on-chain', async () => {
    // Full-pipeline version of the resolveSubcardPubkey test above: a
    // valid signature from an on-chain-inactive sub-card must still pass
    // verification end to end. UUID registration eligibility depends only
    // on proving key control, never on SubCardEntry.active.
    const sc = subcardKeys();
    const cid = new TextEncoder().encode('bafyTestCid');
    const registryClient = makeRegistryClient({ sub_card_doc_cid: cid, active: false });
    mockIpfsFetch(sc.pubkeyB64);

    const payload = buildPayload({ subcard_hash: sc.subcardHash });
    const envelope: UuidRegistrationEnvelope = { payload, signature: sign(payload, sc.secretKey) };

    const result = await verifyUuidRegistrationEnvelope(CONFIG, envelope, registryClient);
    expect(result.ok).toBe(true);
    vi.unstubAllGlobals();
  });

  it('rejects when keccak256(resolved pubkey) does not match subcard_hash', async () => {
    const sc = subcardKeys();
    const wrongSc = subcardKeys();
    const cid = new TextEncoder().encode('bafyTestCid');
    // Registry is asked about sc.subcardHash but IPFS returns wrongSc's pubkey.
    const registryClient = makeRegistryClient({ sub_card_doc_cid: cid });
    mockIpfsFetch(wrongSc.pubkeyB64);

    const payload = buildPayload({ subcard_hash: sc.subcardHash });
    const envelope: UuidRegistrationEnvelope = { payload, signature: sign(payload, wrongSc.secretKey) };

    const result = await verifyUuidRegistrationEnvelope(CONFIG, envelope, registryClient);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/does not match subcard_hash/);
    }
    vi.unstubAllGlobals();
  });

  it("rejects a signature made with a different sub-card's key (wrong signer)", async () => {
    const sc = subcardKeys();
    const attacker = subcardKeys();
    const cid = new TextEncoder().encode('bafyTestCid');
    const registryClient = makeRegistryClient({ sub_card_doc_cid: cid });
    mockIpfsFetch(sc.pubkeyB64); // registry correctly resolves sc's own pubkey

    const payload = buildPayload({ subcard_hash: sc.subcardHash });
    // Signed by a different sub-card's key entirely — verification must fail
    // even though the resolved pubkey/hash pairing is internally consistent.
    const envelope: UuidRegistrationEnvelope = { payload, signature: sign(payload, attacker.secretKey) };

    const result = await verifyUuidRegistrationEnvelope(CONFIG, envelope, registryClient);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/invalid signature/);
    }
    vi.unstubAllGlobals();
  });

  it('rejects a tampered payload (signature no longer matches)', async () => {
    const sc = subcardKeys();
    const cid = new TextEncoder().encode('bafyTestCid');
    const registryClient = makeRegistryClient({ sub_card_doc_cid: cid });
    mockIpfsFetch(sc.pubkeyB64);

    const payload = buildPayload({ subcard_hash: sc.subcardHash });
    const signature = sign(payload, sc.secretKey);
    const tamperedPayload = { ...payload, uuids: [crypto.randomUUID(), crypto.randomUUID()] };
    const envelope: UuidRegistrationEnvelope = { payload: tamperedPayload, signature };

    const result = await verifyUuidRegistrationEnvelope(CONFIG, envelope, registryClient);
    expect(result.ok).toBe(false);
    vi.unstubAllGlobals();
  });

  it('rejects a missing/empty signature', async () => {
    const sc = subcardKeys();
    const cid = new TextEncoder().encode('bafyTestCid');
    const registryClient = makeRegistryClient({ sub_card_doc_cid: cid });
    mockIpfsFetch(sc.pubkeyB64);

    const payload = buildPayload({ subcard_hash: sc.subcardHash });
    const envelope: UuidRegistrationEnvelope = { payload, signature: '' };

    const result = await verifyUuidRegistrationEnvelope(CONFIG, envelope, registryClient);
    expect(result.ok).toBe(false);
    vi.unstubAllGlobals();
  });
});
