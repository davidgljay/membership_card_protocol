import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { handleUuidRegistration, type RawUuidRegistrationBody } from '../src/routes/subcard-uuid-registration.js';
import { canonicalize } from '../src/canonicalize.js';
import type { UuidRegistrationPayload } from '../src/auth/subcard-uuid-signature.js';
import type { WalletServiceConfig } from '../src/config.js';
import type { Hex } from 'viem';
import type { SubcardRegistryClient, SubCardEntry } from '../src/chain/subcard-registry.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://wallet_service:wallet_service@localhost:5433/wallet_service';

const CONFIG = {
  IPFS_GATEWAY_URL: 'https://ipfs.example.test',
  RELAY_BASE_URL: 'http://relay.example.test',
} as unknown as WalletServiceConfig;

function subcardKeys() {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const keys = ml_dsa44.keygen(seed);
  const subcardHash = '0x' + Buffer.from(keccak_256(keys.publicKey)).toString('hex');
  const pubkeyB64 = Buffer.from(keys.publicKey).toString('base64url');
  return { ...keys, subcardHash, pubkeyB64 };
}

function makeRegistryClient(pubkeyB64: string, overrides: Partial<SubCardEntry> = {}): SubcardRegistryClient {
  const cid = new TextEncoder().encode('bafyTestCid-' + crypto.randomUUID());
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ recipient_pubkey: pubkeyB64 }),
    })
  );
  return {
    getSubCardEntry: vi.fn().mockResolvedValue({
      master_card_address: ('0x' + '11'.repeat(32)) as Hex,
      registration_log_head: new Uint8Array(),
      sub_card_doc_cid: cid,
      active: true,
      registered_at: 0n,
      deregistered_at: 0n,
      ...overrides,
    } satisfies SubCardEntry),
  };
}

function buildPayload(cardHash: string, subcardHash: string, overrides: Partial<UuidRegistrationPayload> = {}) {
  return {
    card_hash: cardHash,
    subcard_hash: subcardHash,
    uuids: [crypto.randomUUID()],
    timestamp: new Date().toISOString(),
    nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
    ...overrides,
  };
}

function sign(payload: UuidRegistrationPayload, secretKey: Uint8Array): string {
  return Buffer.from(ml_dsa44.sign(canonicalize(payload), secretKey)).toString('base64url');
}

function envelopeFor(
  payload: UuidRegistrationPayload,
  secretKey: Uint8Array,
  signatureOverride?: string
): RawUuidRegistrationBody {
  return {
    payload,
    signature: signatureOverride ?? sign(payload, secretKey),
  };
}

describe('handleUuidRegistration (notification_relay.md v0.8 §POST .../uuids)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('accepts a validly signed request and registers the UUIDs', async () => {
    const sc = subcardKeys();
    const cardHash = '0xtest-' + crypto.randomUUID();
    const registryClient = makeRegistryClient(sc.pubkeyB64);
    const payload = buildPayload(cardHash, sc.subcardHash);
    const rawBody = envelopeFor(payload, sc.secretKey);

    const outcome = await handleUuidRegistration({
      pool,
      config: CONFIG,
      cardHashParam: cardHash,
      subcardHashParam: sc.subcardHash,
      rawBody,
      registryClient,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.registeredCount).toBe(1);
    }

    const { rows } = await pool.query('SELECT uuid FROM uuid_pools WHERE card_hash = $1', [cardHash]);
    expect(rows).toHaveLength(1);
    expect(rows[0].uuid).toBe(payload.uuids[0]);

    vi.unstubAllGlobals();
  });

  it('rejects a request with no signature field at all (old bare-array shape)', async () => {
    const sc = subcardKeys();
    const cardHash = '0xtest-' + crypto.randomUUID();
    const registryClient = makeRegistryClient(sc.pubkeyB64);

    // The pre-v0.8 shape: bare { uuids: [...] }.
    const outcome = await handleUuidRegistration({
      pool,
      config: CONFIG,
      cardHashParam: cardHash,
      subcardHashParam: sc.subcardHash,
      rawBody: { uuids: [crypto.randomUUID()] } as unknown as RawUuidRegistrationBody,
      registryClient,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.statusCode).toBe(400);
    }

    const { rows } = await pool.query('SELECT uuid FROM uuid_pools WHERE card_hash = $1', [cardHash]);
    expect(rows).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it("rejects a signature made with a different sub-card's key", async () => {
    const sc = subcardKeys();
    const attacker = subcardKeys();
    const cardHash = '0xtest-' + crypto.randomUUID();
    const registryClient = makeRegistryClient(sc.pubkeyB64); // registry correctly resolves sc's own key
    const payload = buildPayload(cardHash, sc.subcardHash);
    const rawBody = envelopeFor(payload, attacker.secretKey); // signed by someone else

    const outcome = await handleUuidRegistration({
      pool,
      config: CONFIG,
      cardHashParam: cardHash,
      subcardHashParam: sc.subcardHash,
      rawBody,
      registryClient,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.statusCode).toBe(401);
    }

    const { rows } = await pool.query('SELECT uuid FROM uuid_pools WHERE card_hash = $1', [cardHash]);
    expect(rows).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('rejects a tampered payload (signature no longer matches)', async () => {
    const sc = subcardKeys();
    const cardHash = '0xtest-' + crypto.randomUUID();
    const registryClient = makeRegistryClient(sc.pubkeyB64);
    const payload = buildPayload(cardHash, sc.subcardHash);
    const signature = sign(payload, sc.secretKey);
    const tampered = { ...payload, uuids: [crypto.randomUUID(), crypto.randomUUID()] };

    const outcome = await handleUuidRegistration({
      pool,
      config: CONFIG,
      cardHashParam: cardHash,
      subcardHashParam: sc.subcardHash,
      rawBody: { payload: tampered, signature },
      registryClient,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.statusCode).toBe(401);
    }
    vi.unstubAllGlobals();
  });

  it('rejects an expired timestamp', async () => {
    const sc = subcardKeys();
    const cardHash = '0xtest-' + crypto.randomUUID();
    const registryClient = makeRegistryClient(sc.pubkeyB64);
    const staleTimestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    const payload = buildPayload(cardHash, sc.subcardHash, { timestamp: staleTimestamp });
    const rawBody = envelopeFor(payload, sc.secretKey);

    const outcome = await handleUuidRegistration({
      pool,
      config: CONFIG,
      cardHashParam: cardHash,
      subcardHashParam: sc.subcardHash,
      rawBody,
      registryClient,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.statusCode).toBe(401);
      expect(outcome.statusMessage).toMatch(/timestamp/);
    }
    vi.unstubAllGlobals();
  });

  it('rejects a replayed nonce for the same sub-card on a second, otherwise-valid request', async () => {
    const sc = subcardKeys();
    const cardHash = '0xtest-' + crypto.randomUUID();

    // First request: valid, should succeed.
    const registryClient1 = makeRegistryClient(sc.pubkeyB64);
    const payload = buildPayload(cardHash, sc.subcardHash);
    const rawBody = envelopeFor(payload, sc.secretKey);
    const first = await handleUuidRegistration({
      pool,
      config: CONFIG,
      cardHashParam: cardHash,
      subcardHashParam: sc.subcardHash,
      rawBody,
      registryClient: registryClient1,
    });
    expect(first.ok).toBe(true);
    vi.unstubAllGlobals();

    // Second request: identical payload/signature/nonce replayed verbatim.
    const registryClient2 = makeRegistryClient(sc.pubkeyB64);
    const second = await handleUuidRegistration({
      pool,
      config: CONFIG,
      cardHashParam: cardHash,
      subcardHashParam: sc.subcardHash,
      rawBody,
      registryClient: registryClient2,
    });

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.statusCode).toBe(401);
      expect(second.statusMessage).toMatch(/nonce/);
    }
    vi.unstubAllGlobals();
  });

  it('rejects when payload.card_hash does not match the route path', async () => {
    const sc = subcardKeys();
    const cardHash = '0xtest-' + crypto.randomUUID();
    const otherCardHash = '0xtest-' + crypto.randomUUID();
    const registryClient = makeRegistryClient(sc.pubkeyB64);
    const payload = buildPayload(otherCardHash, sc.subcardHash); // signed for a different card_hash
    const rawBody = envelopeFor(payload, sc.secretKey);

    const outcome = await handleUuidRegistration({
      pool,
      config: CONFIG,
      cardHashParam: cardHash, // route path says cardHash
      subcardHashParam: sc.subcardHash,
      rawBody,
      registryClient,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.statusCode).toBe(403);
      expect(outcome.statusMessage).toMatch(/card_hash/);
    }
    vi.unstubAllGlobals();
  });

  it('rejects when payload.subcard_hash does not match the route path (a signed envelope for one subcard replayed against another URL)', async () => {
    const sc = subcardKeys();
    const otherSc = subcardKeys();
    const cardHash = '0xtest-' + crypto.randomUUID();
    const registryClient = makeRegistryClient(sc.pubkeyB64);
    const payload = buildPayload(cardHash, sc.subcardHash); // signed for sc's subcard_hash
    const rawBody = envelopeFor(payload, sc.secretKey);

    const outcome = await handleUuidRegistration({
      pool,
      config: CONFIG,
      cardHashParam: cardHash,
      subcardHashParam: otherSc.subcardHash, // but posted against a different subcard's URL
      rawBody,
      registryClient,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.statusCode).toBe(403);
      expect(outcome.statusMessage).toMatch(/subcard_hash/);
    }
    vi.unstubAllGlobals();
  });

  it('rejects when card_hash or subcard_hash route params are missing', async () => {
    const sc = subcardKeys();
    const registryClient = makeRegistryClient(sc.pubkeyB64);
    const payload = buildPayload('0xsomething', sc.subcardHash);
    const rawBody = envelopeFor(payload, sc.secretKey);

    const outcome = await handleUuidRegistration({
      pool,
      config: CONFIG,
      cardHashParam: undefined,
      subcardHashParam: sc.subcardHash,
      rawBody,
      registryClient,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.statusCode).toBe(400);
    }
    vi.unstubAllGlobals();
  });
});
