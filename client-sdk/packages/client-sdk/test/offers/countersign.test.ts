import { describe, it, expect, vi } from 'vitest';
import { mlDsa44GenerateKeypair, mlDsa44Verify } from '../../src/crypto/mldsa.js';
import { canonicalize } from '../../src/crypto/canonicalize.js';
import { encryptKeyring, decryptKeyring } from '../../src/wallet/keyring.js';
import { keccak256 } from '../../src/crypto/hashes.js';
import { base64UrlToBytes } from '../../src/util/base64url.js';
import type { StorageProvider } from '../../src/providers/StorageProvider.js';
import type { ApprovedTargetedOffer, ApprovedOpenOffer } from '../../src/offers/offerVerification.js';
import type { SignedTargetedOffer } from '../../src/offers/targetedOffer.js';
import type { SignedOpenCardOffer } from '../../src/offers/openOffer.js';

const callOrder = vi.hoisted(() => [] as string[]);

vi.mock('../../src/crypto/mldsa.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/crypto/mldsa.js')>();
  return {
    ...actual,
    mlDsa44Sign: vi.fn((secretKey: Uint8Array, message: Uint8Array) => {
      callOrder.push('sign');
      return actual.mlDsa44Sign(secretKey, message);
    }),
  };
});

import { acceptTargetedOfferAndCountersign, acceptOpenOfferAndCountersign } from '../../src/offers/countersign.js';

const DECRYPTION_KEY = new Uint8Array(32).fill(7);
const MASTER_CARD_ADDRESS = 'aa'.repeat(32);

function makeFakeStorageProvider(initialBlob?: Uint8Array): StorageProvider & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  if (initialBlob) store.set('keyring', initialBlob);
  return {
    store,
    get: vi.fn(async (key: string) => {
      return store.get(key);
    }),
    set: vi.fn(async (key: string, value: Uint8Array) => {
      callOrder.push('write');
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

function makeInitialKeyringBlob(): Uint8Array {
  const master = mlDsa44GenerateKeypair();
  return encryptKeyring([{ cardAddress: MASTER_CARD_ADDRESS, privateKey: master.secretKey }], DECRYPTION_KEY);
}

function makeApprovedTargetedOffer(): ApprovedTargetedOffer {
  const issuer = mlDsa44GenerateKeypair();
  const offer: SignedTargetedOffer = {
    policy_id: 'policy-cid',
    issuer_card: keccak256(issuer.publicKey),
    press_card: 'press-card',
    issued_at: '2026-01-01T00:00:00.000Z',
    ancestry_pubkeys: [],
    issuer_signature: 'sig',
    tier: 'gold',
  };
  return {
    approved: true,
    offer,
    issuerVerification: {
      signer_card: offer.issuer_card,
      signature_valid: null,
      protocol_version: '0.1',
      scope_clean: 'skipped',
      chain_reaches_trusted_root: true,
      app_card_chain_valid: 'skipped',
      revocation: { status: 'not_revoked', code: null, effective_date: null, data_freshness_seconds: 0 },
      was_valid_at_signing_time: true,
      is_currently_valid: true,
      log_updates: [],
      policy_compliant: 'skipped',
      policy_match: null,
      press_subsequently_revoked: false,
      non_compliance_reported: false,
      addressed_to_verifier: false,
      errors: [],
      annotations: [],
    },
  };
}

function makeApprovedOpenOffer(): ApprovedOpenOffer {
  const issuer = mlDsa44GenerateKeypair();
  const offer: SignedOpenCardOffer = {
    offer_type: 'open',
    policy_id: 'policy-cid',
    press_card: 'press-card',
    issuer_card: keccak256(issuer.publicKey),
    issuer_pubkey: 'irrelevant-for-this-test',
    max_acceptances: 10,
    expires_at: null,
    proposed_fields: { tier: 'silver' },
    issuer_signature: 'sig',
  };
  return {
    approved: true,
    offer,
    issuerVerification: makeApprovedTargetedOffer().issuerVerification,
  };
}

describe('acceptTargetedOfferAndCountersign', () => {
  it('writes the keyring before signing, and the countersignature verifies against the new key', async () => {
    callOrder.length = 0;
    const storageProvider = makeFakeStorageProvider(makeInitialKeyringBlob());
    const approved = makeApprovedTargetedOffer();

    const result = await acceptTargetedOfferAndCountersign(approved, { storageProvider, decryptionKey: DECRYPTION_KEY });

    // Call-order assertion, not just final-state: the write happened before
    // the sign.
    expect(callOrder).toEqual(['write', 'sign']);

    // The stored keyring now contains both the original master entry and
    // the new card's entry.
    const finalBlob = storageProvider.store.get('keyring')!;
    const entries = decryptKeyring(finalBlob, DECRYPTION_KEY);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.cardAddress).toBe(MASTER_CARD_ADDRESS);
    expect(entries[1]!.cardAddress).toBe(keccak256(result.newCardPublicKey));

    // The countersignature verifies against the new key over offer + recipient_pubkey.
    expect(result.countersignedOffer.recipient_pubkey).toBe(
      Buffer.from(result.newCardPublicKey).toString('base64url')
    );
    const { holder_signature, ...withoutHolderSig } = result.countersignedOffer;
    expect(
      mlDsa44Verify(result.newCardPublicKey, canonicalize(withoutHolderSig), base64UrlToBytes(holder_signature))
    ).toBe(true);
  });

  it('never produces a countersignature if the keyring write fails — errors out before signing, not after', async () => {
    callOrder.length = 0;
    const storageProvider = makeFakeStorageProvider(makeInitialKeyringBlob());
    storageProvider.set = vi.fn(async () => {
      callOrder.push('write-attempted');
      throw new Error('storage write failed');
    });
    const approved = makeApprovedTargetedOffer();

    await expect(
      acceptTargetedOfferAndCountersign(approved, { storageProvider, decryptionKey: DECRYPTION_KEY })
    ).rejects.toThrow('storage write failed');

    // The write was attempted, but sign was never reached.
    expect(callOrder).toEqual(['write-attempted']);
    expect(callOrder).not.toContain('sign');
  });

  it('throws (before signing) if no keyring exists in storage', async () => {
    callOrder.length = 0;
    const storageProvider = makeFakeStorageProvider(); // no initial blob
    const approved = makeApprovedTargetedOffer();

    await expect(
      acceptTargetedOfferAndCountersign(approved, { storageProvider, decryptionKey: DECRYPTION_KEY })
    ).rejects.toThrow(/no keyring found/);
    expect(callOrder).not.toContain('sign');
  });
});

describe('acceptOpenOfferAndCountersign', () => {
  it('writes the keyring before signing, and produces a claim submission signed by the new key', async () => {
    callOrder.length = 0;
    const storageProvider = makeFakeStorageProvider(makeInitialKeyringBlob());
    const approved = makeApprovedOpenOffer();

    const result = await acceptOpenOfferAndCountersign(approved, { storageProvider, decryptionKey: DECRYPTION_KEY });

    expect(callOrder).toEqual(['write', 'sign']);

    const finalBlob = storageProvider.store.get('keyring')!;
    const entries = decryptKeyring(finalBlob, DECRYPTION_KEY);
    expect(entries).toHaveLength(2);
    expect(entries[1]!.cardAddress).toBe(keccak256(result.newCardPublicKey));

    expect(result.claimSubmission.claim_payload.offer).toBe(approved.offer);
    expect(result.claimSubmission.claim_payload.recipient_pubkey).toBe(
      Buffer.from(result.newCardPublicKey).toString('base64url')
    );
    const signature = base64UrlToBytes(result.claimSubmission.recipient_signature);
    expect(
      mlDsa44Verify(result.newCardPublicKey, canonicalize(result.claimSubmission.claim_payload), signature)
    ).toBe(true);
  });

  it('never produces a claim submission if the keyring write fails', async () => {
    callOrder.length = 0;
    const storageProvider = makeFakeStorageProvider(makeInitialKeyringBlob());
    storageProvider.set = vi.fn(async () => {
      callOrder.push('write-attempted');
      throw new Error('storage write failed');
    });
    const approved = makeApprovedOpenOffer();

    await expect(
      acceptOpenOfferAndCountersign(approved, { storageProvider, decryptionKey: DECRYPTION_KEY })
    ).rejects.toThrow('storage write failed');
    expect(callOrder).not.toContain('sign');
  });
});
