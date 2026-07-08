// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { webcrypto } from 'crypto';
import { describe, it, expect } from 'vitest';
import { mlDsa44GenerateKeypair, mlDsa44Verify, canonicalize, keccak256 } from '@membership-card-protocol/app-sdk';
import { base64UrlToBytes } from '@membership-card-protocol/app-sdk';
import type { SignedTargetedOffer } from '@membership-card-protocol/app-sdk';
import type { ApprovedTargetedOffer } from '../../src/offers/offerVerification.js';
import { acceptTargetedOfferAndCountersign } from '../../src/offers/countersign.js';
import { encryptKeyring } from '../../src/wallet/keyring.js';
import { IndexedDBStorageProvider } from '@membership-card-protocol/sdk-providers-web';

/**
 * Cross-platform scenario test (Step 3.2c): targeted-offer acceptance
 * (`acceptTargetedOfferAndCountersign`, `offers/countersign.ts`) against a
 * *real* `IndexedDBStorageProvider` from `sdk-providers-web` — not an
 * in-memory fake — confirming the "persist before sign" invariant holds
 * against an actual browser-grade storage backend: `fake-indexeddb`
 * (jsdom doesn't ship a native `IndexedDB` implementation) polyfills the
 * `indexedDB` global the provider's own `indexeddb.ts` calls, exactly as
 * `sdk-providers-web`'s own `test/setup.ts` does for its own suite.
 *
 * `crypto.subtle` is also polyfilled from Node's `webcrypto` — jsdom's
 * `crypto` lacks `SubtleCrypto`, and while this particular scenario doesn't
 * call it directly, `IndexedDBStorageProvider`'s sibling provider
 * (`WebCryptoSecureKeyProvider`) does, and this polyfill keeps every
 * web-flavored scenario file in this directory consistent.
 */

if (!globalThis.crypto.subtle) {
  Object.defineProperty(globalThis.crypto, 'subtle', {
    value: webcrypto.subtle,
    writable: false,
    configurable: false,
  });
}

const DECRYPTION_KEY = new Uint8Array(32).fill(7);
const MASTER_CARD_ADDRESS = 'aa'.repeat(32);

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

describe('acceptTargetedOfferAndCountersign end-to-end (real IndexedDBStorageProvider, Step 3.2c)', () => {
  it('persists the new card key to real IndexedDB before signing, and the resulting signature verifies', async () => {
    const storageProvider = new IndexedDBStorageProvider('scenario-offer-acceptance');

    // Seed the keyring exactly as setupWallet would have left it: one
    // entry (the master key), encrypted under DECRYPTION_KEY, written to
    // the real IndexedDB-backed store this provider wraps.
    const master = mlDsa44GenerateKeypair();
    const initialBlob = encryptKeyring(
      [{ cardAddress: MASTER_CARD_ADDRESS, privateKey: master.secretKey }],
      DECRYPTION_KEY
    );
    await storageProvider.set('keyring', initialBlob);

    // Sanity: confirm this really round-tripped through IndexedDB (not an
    // in-memory shortcut) before proceeding. Compared as plain arrays,
    // since fake-indexeddb's structured-clone round trip can return a
    // Uint8Array view whose underlying ArrayBuffer/byteOffset metadata
    // differs from the original even though the byte values are identical
    // — `toEqual` on the raw typed arrays would spuriously fail on that
    // metadata, not the actual bytes.
    const readBack = await storageProvider.get('keyring');
    expect(readBack).toBeDefined();
    expect(Array.from(readBack!)).toEqual(Array.from(initialBlob));

    const approved = makeApprovedTargetedOffer();

    const result = await acceptTargetedOfferAndCountersign(approved, {
      storageProvider,
      decryptionKey: DECRYPTION_KEY,
    });

    // The new card's private key must now be persisted in the real
    // IndexedDB-backed keyring blob (persist-before-sign) — confirm the
    // blob stored there actually changed (grew by one entry) as a result
    // of this call, not just that the function returned a public key.
    const updatedBlob = await storageProvider.get('keyring');
    expect(updatedBlob).toBeDefined();
    expect(Array.from(updatedBlob!)).not.toEqual(Array.from(initialBlob));

    // And the signature this call produced verifies against the new
    // card's public key over the exact offer-plus-recipient-pubkey
    // canonical bytes — proving the countersign step used the key that
    // was, by construction, already durably persisted before this
    // function could have called mlDsa44Sign.
    const { holder_signature, ...withoutSignature } = result.countersignedOffer;
    expect(
      mlDsa44Verify(result.newCardPublicKey, canonicalize(withoutSignature), base64UrlToBytes(holder_signature))
    ).toBe(true);
  });

  it('throws rather than sign if no keyring exists in the real IndexedDB store yet (never signs on a failed write)', async () => {
    const storageProvider = new IndexedDBStorageProvider('scenario-offer-acceptance-empty');
    const approved = makeApprovedTargetedOffer();

    await expect(
      acceptTargetedOfferAndCountersign(approved, {
        storageProvider,
        decryptionKey: DECRYPTION_KEY,
      })
    ).rejects.toThrow(/no keyring found in storage/);
  });
});
