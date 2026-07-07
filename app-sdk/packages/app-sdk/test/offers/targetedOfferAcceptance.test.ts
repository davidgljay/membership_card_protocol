import { describe, it, expect, vi } from 'vitest';
import { assembleAndSignTargetedOffer } from '../../src/offers/targetedOffer.js';
import { forwardCountersignedTargetedOffer } from '../../src/offers/targetedOfferAcceptance.js';
import { mlDsa44GenerateKeypair, mlDsa44Sign, mlDsa44Verify } from '../../src/crypto/mldsa.js';
import { canonicalize } from '../../src/crypto/canonicalize.js';
import { keccak256 } from '../../src/crypto/hashes.js';
import { bytesToBase64Url, base64UrlToBytes } from '../../src/util/base64url.js';
import type { SecureKeyProvider } from '../../src/providers/SecureKeyProvider.js';
import type {
  ObliviousProtocolTransport,
  ObliviousDestination,
  RequestOptions,
  ObliviousResponse,
} from '../../src/providers/ObliviousProtocolTransport.js';

/**
 * This file ports only the `forwardCountersignedTargetedOffer` (offerer
 * side) test cases from the original unified `targetedOfferAcceptance.test.ts`.
 * The recipient-side `acceptTargetedOffer` (review + countersign, including
 * the keyring "persist before sign" invariant) is a Wallet SDK concern —
 * its test cases stay with Wallet SDK's own `targetedOfferAcceptance.test.ts`.
 * The full end-to-end scenario (offerer creates, recipient countersigns via
 * a stand-in `CountersignedTargetedOffer` value, offerer forwards) is
 * preserved here with the recipient's countersign step inlined directly
 * (via `mlDsa44Sign`) rather than calling any Wallet-SDK-only function, so
 * `forwardCountersignedTargetedOffer`'s own contract — reconstructing the
 * trusted payload and verifying `holder_signature` before ever contacting
 * the press — is still exercised end to end.
 */

function jsonResponse(status: number, body: unknown): ObliviousResponse {
  return { status, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
}
function readJsonBody(options: RequestOptions): Record<string, unknown> {
  if (!options.body) return {};
  return JSON.parse(new TextDecoder().decode(options.body)) as Record<string, unknown>;
}

function makeIssuerSigner(keypair: { publicKey: Uint8Array; secretKey: Uint8Array }): SecureKeyProvider {
  return {
    generateKey: vi.fn(async () => keypair.publicKey),
    sign: vi.fn(async (_id: string, message: Uint8Array) => mlDsa44Sign(keypair.secretKey, message)),
    getPublicKey: vi.fn(async () => keypair.publicKey),
    delete: vi.fn(),
  };
}

const PRESS_CARD = 'dd'.repeat(32);
const PRESS_BASE_URL = 'https://press.example';

describe('offerer-side press finalization (Step 3.6 / forwardCountersignedTargetedOffer)', () => {
  it('end-to-end: offerer creates + forwards, recipient countersigns, press finalizes — completed card carries all three signatures, offerer holds the SCIP', async () => {
    const issuer = mlDsa44GenerateKeypair();
    const issuerAddress = keccak256(issuer.publicKey);
    const press = mlDsa44GenerateKeypair();

    // --- Offerer creates the offer (Step 3.1). ---
    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider: makeIssuerSigner(issuer),
      issuerSigningKeyId: 'issuer-key',
      policyId: 'policy-cid',
      issuerCard: issuerAddress,
      pressCard: PRESS_CARD,
      ancestryPubkeys: [issuer.publicKey],
      fieldValues: { tier: 'platinum' },
    });

    // --- Recipient countersigns (Wallet-SDK-owned in the real flow;
    // inlined here purely to produce a valid CountersignedTargetedOffer
    // input for forwardCountersignedTargetedOffer). ---
    const newCard = mlDsa44GenerateKeypair();
    const withRecipient = { ...offer, recipient_pubkey: bytesToBase64Url(newCard.publicKey) };
    const holderSignature = mlDsa44Sign(newCard.secretKey, canonicalize(withRecipient));
    const countersignedOffer = {
      recipient_pubkey: bytesToBase64Url(newCard.publicKey),
      holder_signature: bytesToBase64Url(holderSignature),
    };

    // --- Offerer validates and forwards to the press (Phase 6, Step 16). ---
    const pressCalls: Array<{ destination: ObliviousDestination; body: Record<string, unknown> }> = [];
    const transport: ObliviousProtocolTransport = {
      request: vi.fn(async (destination: ObliviousDestination, requestOptions: RequestOptions) => {
        expect(destination).toEqual({ kind: 'press', baseUrl: PRESS_BASE_URL });
        expect(requestOptions.path).toBe('/issue/finalize');
        const body = readJsonBody(requestOptions);
        pressCalls.push({ destination, body });

        // Simulate the press: sign the complete document (the submitted
        // card has no press_signature field yet) with the press key.
        const pressSignature = mlDsa44Sign(press.secretKey, canonicalize(body));

        return jsonResponse(200, {
          card_cid: 'card-cid-targeted-123',
          scip: {
            card_cid: 'card-cid-targeted-123',
            policy_log_entry_index: 1,
            policy_log_root_at_inclusion: 'policy-log-root-cid',
            issued_at: new Date().toISOString(),
            press_signature: { public_key: bytesToBase64Url(press.publicKey), signature: bytesToBase64Url(pressSignature) },
          },
        });
      }),
    };

    const forwardResult = await forwardCountersignedTargetedOffer({
      originalOffer: offer,
      countersignedOffer,
      transport,
      pressBaseUrl: PRESS_BASE_URL,
    });

    expect(forwardResult.forwarded).toBe(true);
    if (!forwardResult.forwarded) throw new Error('unreachable');
    expect(forwardResult.cardCid).toBe('card-cid-targeted-123');

    // The press only ever saw the destination-parameterized oblivious
    // transport — never a direct fetch — for the finalization call.
    expect(pressCalls).toHaveLength(1);

    // The completed card (what the offerer actually submitted, now with a
    // press_signature) carries all three verifiable signatures.
    const submittedCard = pressCalls[0]!.body;
    const { issuer_signature, holder_signature, recipient_pubkey, ...offerFieldsOnly } = submittedCard as Record<
      string,
      unknown
    > & { issuer_signature: string; holder_signature: string; recipient_pubkey: string };

    // issuer_signature: over the original offer fields (excludes recipient_pubkey/holder_signature).
    expect(mlDsa44Verify(issuer.publicKey, canonicalize(offerFieldsOnly), base64UrlToBytes(issuer_signature))).toBe(true);

    // holder_signature: over offer fields (including issuer_signature) + recipient_pubkey.
    const withRecipientCheck = { ...offerFieldsOnly, issuer_signature, recipient_pubkey };
    expect(
      mlDsa44Verify(newCard.publicKey, canonicalize(withRecipientCheck), base64UrlToBytes(holder_signature))
    ).toBe(true);

    // press_signature (from the SCIP, in this simulated press): over the
    // complete countersigned document minus press_signature itself.
    const pressSigEntry = forwardResult.scip.press_signature;
    expect(
      mlDsa44Verify(base64UrlToBytes(pressSigEntry.public_key), canonicalize(submittedCard), base64UrlToBytes(pressSigEntry.signature))
    ).toBe(true);

    // The offerer holds the SCIP (for out-of-band delivery back to the recipient).
    expect(forwardResult.scip.card_cid).toBe('card-cid-targeted-123');
  });

  it('refuses to forward when holder_signature does not verify, without ever calling the press', async () => {
    const issuer = mlDsa44GenerateKeypair();
    const issuerAddress = keccak256(issuer.publicKey);
    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider: makeIssuerSigner(issuer),
      issuerSigningKeyId: 'issuer-key',
      policyId: 'policy-cid',
      issuerCard: issuerAddress,
      pressCard: PRESS_CARD,
      ancestryPubkeys: [issuer.publicKey],
      fieldValues: {},
    });

    const forgedRecipient = mlDsa44GenerateKeypair();
    const transport: ObliviousProtocolTransport = { request: vi.fn() };

    const result = await forwardCountersignedTargetedOffer({
      originalOffer: offer,
      countersignedOffer: {
        recipient_pubkey: bytesToBase64Url(forgedRecipient.publicKey),
        // Signature produced over the WRONG payload (missing recipient_pubkey) — won't verify.
        holder_signature: bytesToBase64Url(mlDsa44Sign(forgedRecipient.secretKey, canonicalize(offer))),
      },
      transport,
      pressBaseUrl: PRESS_BASE_URL,
    });

    expect(result.forwarded).toBe(false);
    if (result.forwarded) throw new Error('unreachable');
    expect(result.reason).toMatch(/holder_signature/);
    expect(transport.request).not.toHaveBeenCalled();
  });
});
