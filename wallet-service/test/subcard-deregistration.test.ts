import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { keccak_256 } from '@noble/hashes/sha3';
import {
  handleSubcardDeregistration,
  type RawSubcardDeregistrationBody,
} from '../src/routes/subcard-deregistration.js';
import { handleUuidRegistration, type RawUuidRegistrationBody } from '../src/routes/subcard-uuid-registration.js';
import { canonicalize } from '../src/canonicalize.js';
import type { SubcardDeregistrationPayload } from '../src/auth/subcard-deregistration-signature.js';
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

function buildRegistrationPayload(
  cardHash: string,
  subcardHash: string,
  overrides: Partial<UuidRegistrationPayload> = {}
): UuidRegistrationPayload {
  return {
    card_hash: cardHash,
    subcard_hash: subcardHash,
    uuids: [crypto.randomUUID()],
    timestamp: new Date().toISOString(),
    nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
    ...overrides,
  };
}

function buildDeregistrationPayload(
  cardHash: string,
  subcardHash: string,
  overrides: Partial<SubcardDeregistrationPayload> = {}
): SubcardDeregistrationPayload {
  return {
    card_hash: cardHash,
    subcard_hash: subcardHash,
    timestamp: new Date().toISOString(),
    nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
    ...overrides,
  };
}

function sign(payload: unknown, secretKey: Uint8Array): string {
  return Buffer.from(ml_dsa44.sign(canonicalize(payload), secretKey)).toString('base64url');
}

function deregEnvelopeFor(
  payload: SubcardDeregistrationPayload,
  secretKey: Uint8Array,
  signatureOverride?: string
): RawSubcardDeregistrationBody {
  return {
    payload,
    signature: signatureOverride ?? sign(payload, secretKey),
  };
}

describe('handleSubcardDeregistration (notification_relay.md v0.9 §Multi-Device Support "Deregistration")', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  /** Registers a subcard's UUIDs first so it has history to deregister (subcardHasAnyHistory). */
  async function registerFirst(
    cardHash: string,
    sc: ReturnType<typeof subcardKeys>,
    registryClient: SubcardRegistryClient
  ): Promise<void> {
    const payload = buildRegistrationPayload(cardHash, sc.subcardHash);
    const rawBody: RawUuidRegistrationBody = { payload, signature: sign(payload, sc.secretKey) };
    const outcome = await handleUuidRegistration({
      pool,
      config: CONFIG,
      cardHashParam: cardHash,
      subcardHashParam: sc.subcardHash,
      rawBody,
      registryClient,
    });
    expect(outcome.ok).toBe(true);
    vi.unstubAllGlobals();
  }

  it('accepts a validly signed deregistration request and consumes the UUID pool', async () => {
    const sc = subcardKeys();
    const cardHash = '0xtest-' + crypto.randomUUID();
    await registerFirst(cardHash, sc, makeRegistryClient(sc.pubkeyB64));

    const registryClient = makeRegistryClient(sc.pubkeyB64);
    const payload = buildDeregistrationPayload(cardHash, sc.subcardHash);
    const rawBody = deregEnvelopeFor(payload, sc.secretKey);

    const outcome = await handleSubcardDeregistration({
      pool,
      config: CONFIG,
      cardHashParam: cardHash,
      subcardHashParam: sc.subcardHash,
      rawBody,
      registryClient,
    });

    expect(outcome.ok).toBe(true);

    const { rows } = await pool.query('SELECT consumed FROM uuid_pools WHERE card_hash = $1', [cardHash]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.consumed === true)).toBe(true);
    vi.unstubAllGlobals();
  });

  it('accepts a validly signed deregistration for a subcard that is inactive (deregistered) on-chain', async () => {
    // Proves the correction-1 fix applies to deregistration too: eligibility
    // depends only on a valid signature, never on SubCardEntry.active.
    const sc = subcardKeys();
    const cardHash = '0xtest-' + crypto.randomUUID();
    await registerFirst(cardHash, sc, makeRegistryClient(sc.pubkeyB64));

    const registryClient = makeRegistryClient(sc.pubkeyB64, { active: false });
    const payload = buildDeregistrationPayload(cardHash, sc.subcardHash);
    const rawBody = deregEnvelopeFor(payload, sc.secretKey);

    const outcome = await handleSubcardDeregistration({
      pool,
      config: CONFIG,
      cardHashParam: cardHash,
      subcardHashParam: sc.subcardHash,
      rawBody,
      registryClient,
    });

    expect(outcome.ok).toBe(true);
    vi.unstubAllGlobals();
  });

  it('rejects a request with a missing signature', async () => {
    const sc = subcardKeys();
    const cardHash = '0xtest-' + crypto.randomUUID();
    await registerFirst(cardHash, sc, makeRegistryClient(sc.pubkeyB64));

    const registryClient = makeRegistryClient(sc.pubkeyB64);
    const payload = buildDeregistrationPayload(cardHash, sc.subcardHash);

    const outcome = await handleSubcardDeregistration({
      pool,
      config: CONFIG,
      cardHashParam: cardHash,
      subcardHashParam: sc.subcardHash,
      rawBody: { payload, signature: '' },
      registryClient,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.statusCode).toBe(400);
    }

    const { rows } = await pool.query('SELECT consumed FROM uuid_pools WHERE card_hash = $1', [cardHash]);
    expect(rows.every((r) => r.consumed === false)).toBe(true);
    vi.unstubAllGlobals();
  });

  it("rejects a signature made with a different sub-card's key", async () => {
    const sc = subcardKeys();
    const attacker = subcardKeys();
    const cardHash = '0xtest-' + crypto.randomUUID();
    await registerFirst(cardHash, sc, makeRegistryClient(sc.pubkeyB64));

    const registryClient = makeRegistryClient(sc.pubkeyB64); // registry correctly resolves sc's own key
    const payload = buildDeregistrationPayload(cardHash, sc.subcardHash);
    const rawBody = deregEnvelopeFor(payload, attacker.secretKey); // signed by someone else

    const outcome = await handleSubcardDeregistration({
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

    const { rows } = await pool.query('SELECT consumed FROM uuid_pools WHERE card_hash = $1', [cardHash]);
    expect(rows.every((r) => r.consumed === false)).toBe(true);
    vi.unstubAllGlobals();
  });

  it('rejects a tampered payload (signature no longer matches)', async () => {
    const sc = subcardKeys();
    const cardHash = '0xtest-' + crypto.randomUUID();
    await registerFirst(cardHash, sc, makeRegistryClient(sc.pubkeyB64));

    const registryClient = makeRegistryClient(sc.pubkeyB64);
    const payload = buildDeregistrationPayload(cardHash, sc.subcardHash);
    const signature = sign(payload, sc.secretKey);
    const tampered = { ...payload, nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url') };

    const outcome = await handleSubcardDeregistration({
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
    await registerFirst(cardHash, sc, makeRegistryClient(sc.pubkeyB64));

    const registryClient = makeRegistryClient(sc.pubkeyB64);
    const staleTimestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    const payload = buildDeregistrationPayload(cardHash, sc.subcardHash, { timestamp: staleTimestamp });
    const rawBody = deregEnvelopeFor(payload, sc.secretKey);

    const outcome = await handleSubcardDeregistration({
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

  it('rejects a replayed nonce for the same sub-card on a second, otherwise-valid deregistration request', async () => {
    const sc = subcardKeys();
    const cardHash = '0xtest-' + crypto.randomUUID();
    await registerFirst(cardHash, sc, makeRegistryClient(sc.pubkeyB64));

    const registryClient1 = makeRegistryClient(sc.pubkeyB64);
    const payload = buildDeregistrationPayload(cardHash, sc.subcardHash);
    const rawBody = deregEnvelopeFor(payload, sc.secretKey);
    const first = await handleSubcardDeregistration({
      pool,
      config: CONFIG,
      cardHashParam: cardHash,
      subcardHashParam: sc.subcardHash,
      rawBody,
      registryClient: registryClient1,
    });
    expect(first.ok).toBe(true);
    vi.unstubAllGlobals();

    const registryClient2 = makeRegistryClient(sc.pubkeyB64);
    const second = await handleSubcardDeregistration({
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
    await registerFirst(cardHash, sc, makeRegistryClient(sc.pubkeyB64));

    const registryClient = makeRegistryClient(sc.pubkeyB64);
    const payload = buildDeregistrationPayload(otherCardHash, sc.subcardHash); // signed for a different card_hash
    const rawBody = deregEnvelopeFor(payload, sc.secretKey);

    const outcome = await handleSubcardDeregistration({
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

  it('rejects when payload.subcard_hash does not match the route path', async () => {
    const sc = subcardKeys();
    const otherSc = subcardKeys();
    const cardHash = '0xtest-' + crypto.randomUUID();
    await registerFirst(cardHash, sc, makeRegistryClient(sc.pubkeyB64));

    const registryClient = makeRegistryClient(sc.pubkeyB64);
    const payload = buildDeregistrationPayload(cardHash, sc.subcardHash); // signed for sc's subcard_hash
    const rawBody = deregEnvelopeFor(payload, sc.secretKey);

    const outcome = await handleSubcardDeregistration({
      pool,
      config: CONFIG,
      cardHashParam: cardHash,
      subcardHashParam: otherSc.subcardHash, // but issued against a different subcard's URL
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

  it('returns 404 for a subcard that was never registered, even with a validly signed envelope', async () => {
    const sc = subcardKeys();
    const cardHash = '0xtest-' + crypto.randomUUID();
    // Deliberately do NOT call registerFirst -- this subcard has no history.

    const registryClient = makeRegistryClient(sc.pubkeyB64);
    const payload = buildDeregistrationPayload(cardHash, sc.subcardHash);
    const rawBody = deregEnvelopeFor(payload, sc.secretKey);

    const outcome = await handleSubcardDeregistration({
      pool,
      config: CONFIG,
      cardHashParam: cardHash,
      subcardHashParam: sc.subcardHash,
      rawBody,
      registryClient,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.statusCode).toBe(404);
    }
    vi.unstubAllGlobals();
  });

  it('rejects when card_hash or subcard_hash route params are missing', async () => {
    const sc = subcardKeys();
    const registryClient = makeRegistryClient(sc.pubkeyB64);
    const payload = buildDeregistrationPayload('0xsomething', sc.subcardHash);
    const rawBody = deregEnvelopeFor(payload, sc.secretKey);

    const outcome = await handleSubcardDeregistration({
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

  it('a subcard can re-register UUIDs after being deregistered (deregistration does not affect deliverability)', async () => {
    // Explicit end-to-end proof of the spec claim: wallet-service-local
    // deregistration does not brick the subcard. It can register again
    // and is fully functional.
    const sc = subcardKeys();
    const cardHash = '0xtest-' + crypto.randomUUID();
    await registerFirst(cardHash, sc, makeRegistryClient(sc.pubkeyB64));

    const deregRegistryClient = makeRegistryClient(sc.pubkeyB64);
    const deregPayload = buildDeregistrationPayload(cardHash, sc.subcardHash);
    const deregOutcome = await handleSubcardDeregistration({
      pool,
      config: CONFIG,
      cardHashParam: cardHash,
      subcardHashParam: sc.subcardHash,
      rawBody: deregEnvelopeFor(deregPayload, sc.secretKey),
      registryClient: deregRegistryClient,
    });
    expect(deregOutcome.ok).toBe(true);
    vi.unstubAllGlobals();

    const reRegistryClient = makeRegistryClient(sc.pubkeyB64);
    const reRegPayload = buildRegistrationPayload(cardHash, sc.subcardHash);
    const reRegOutcome = await handleUuidRegistration({
      pool,
      config: CONFIG,
      cardHashParam: cardHash,
      subcardHashParam: sc.subcardHash,
      rawBody: { payload: reRegPayload, signature: sign(reRegPayload, sc.secretKey) },
      registryClient: reRegistryClient,
    });

    expect(reRegOutcome.ok).toBe(true);
    if (reRegOutcome.ok) {
      expect(reRegOutcome.registeredCount).toBe(1);
    }

    const { rows } = await pool.query('SELECT uuid, consumed FROM uuid_pools WHERE card_hash = $1 AND uuid = $2', [
      cardHash,
      reRegPayload.uuids[0],
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].consumed).toBe(false);
    vi.unstubAllGlobals();
  });
});
