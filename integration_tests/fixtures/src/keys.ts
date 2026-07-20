/**
 * Deterministic ML-DSA-44 test key material, plus a real (non-fake)
 * in-memory `SecureKeyProvider` for driving app-sdk's offer-assembly
 * functions in fixtures/harnesses without a browser/RN keystore.
 *
 * Determinism is deliberate — every actor's keypair is reproducible from
 * its label alone, so fixture output (offer_cid, card_cid, etc.) is stable
 * across runs against a stack started from a clean volume. Real, randomly
 * generated keys must never use `deriveSeed` (see `mlDsa44GenerateKeypair`'s
 * own doc comment — seeds are "for test vectors only").
 */

import { sha256 } from '@noble/hashes/sha2.js';
import {
  mlDsa44GenerateKeypair,
  mlDsa44Sign,
  type MlDsa44Keypair,
  type SecureKeyProvider,
} from '@membership-card-protocol/app-sdk';

const SEED_NAMESPACE = 'card-protocol-integration-fixture';

/** SHA-256("card-protocol-integration-fixture:<label>") — a stable 32-byte ML-DSA-44 seed. */
export function deriveSeed(label: string): Uint8Array {
  return sha256(new TextEncoder().encode(`${SEED_NAMESPACE}:${label}`));
}

/** A deterministic ML-DSA-44 keypair for the given label, e.g. `"issuer"`, `"holder-1"`. */
export function deriveKeypair(label: string): MlDsa44Keypair {
  return mlDsa44GenerateKeypair(deriveSeed(label));
}

/**
 * Real (not mocked-signature) in-memory `SecureKeyProvider` — every key it
 * hands out is a genuine ML-DSA-44 keypair, deterministically derived from
 * `keyId`, and `sign` produces a real, verifiable signature. Matches the
 * pattern already used by app-sdk's own `targetedOffer.test.ts` (a
 * `SecureKeyProvider` wrapping real keys), generalized into a reusable
 * fixture rather than redefined per call site.
 *
 * Not for production use — `SecureKeyProvider`'s real contract is
 * non-exportable, hardware-backed custody (see its own doc comment); this
 * keeps every private key as a plain in-memory `Uint8Array`, which is
 * exactly what fixtures need and exactly what real usage must not do.
 */
export class InMemorySecureKeyProvider implements SecureKeyProvider {
  private readonly keys = new Map<string, MlDsa44Keypair>();

  async generateKey(keyId: string): Promise<Uint8Array> {
    const keypair = deriveKeypair(keyId);
    this.keys.set(keyId, keypair);
    return keypair.publicKey;
  }

  async sign(keyId: string, message: Uint8Array): Promise<Uint8Array> {
    const keypair = this.keys.get(keyId);
    if (!keypair) throw new Error(`InMemorySecureKeyProvider: no key generated for "${keyId}"`);
    return mlDsa44Sign(keypair.secretKey, message);
  }

  async getPublicKey(keyId: string): Promise<Uint8Array | undefined> {
    return this.keys.get(keyId)?.publicKey;
  }

  async delete(keyId: string): Promise<void> {
    this.keys.delete(keyId);
  }
}
