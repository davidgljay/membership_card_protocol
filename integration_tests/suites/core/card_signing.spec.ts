/**
 * `specs/process_specs/card_signing.md` end-to-end — Phase 3 Step 3.1
 * (pattern-setter). See `suites/README.md` for the conventions this file
 * establishes.
 *
 * Card signing is a pure client-side crypto flow (canonicalize → sign →
 * assemble envelope); it never touches press/registry/network on its own
 * (spec Postconditions: "any party ... can verify ... without a network
 * call"). What makes this an *integration* test rather than a duplicate
 * of `app-sdk`'s own `test/messaging/envelope.test.ts` unit tests is:
 *
 *  1. Signers are real, live-press-issued, on-chain-registered cards
 *     (`mintLiveCard`), not arbitrary in-memory keypairs.
 *  2. Signatures produced by app-sdk's `signMessageEnvelope` are verified
 *     using `@membership-card-protocol/verifier`'s independently-vendored
 *     `canonicalize`/`mlDsa44Verify` (not app-sdk's own copies) — proving
 *     the two packages' vendored crypto stays byte-identical, which is
 *     exactly the kind of drift a same-package unit test cannot catch.
 *
 * Known gap (not this suite's to fix — see the Phase 3 report): app-sdk's
 * `MessageType` union doesn't yet cover the full `card_signing.md` message
 * type taxonomy (`announcement`, `introduction`, `delete`, `flag`, the
 * `api.*`/`mcp.*` machine types, `error`) — tests below use `text`/`edit`,
 * which are implemented, to exercise co-signing/edit/retract/forward
 * mechanics independent of that gap.
 *
 * Requires the `integration_tests` stack up (`docker compose up -d --wait
 * ipfs press` at minimum) and `contracts/deployments/local.json` to exist.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  buildMessagePayload,
  signMessageEnvelope,
  messageId,
  mlDsa44Sign,
  bytesToBase64Url,
  base64UrlToBytes,
  canonicalize as appSdkCanonicalize,
  type EnvelopeSigner,
  type MessagePayload,
} from '@membership-card-protocol/app-sdk';
import { canonicalize as verifierCanonicalize, mlDsa44Verify as verifierMlDsa44Verify } from '@membership-card-protocol/verifier';
import { mintLiveCard, type LiveIdentity } from '../support/liveCard.js';

function signerFrom(identity: LiveIdentity): EnvelopeSigner {
  return { publicKey: identity.publicKey, sign: (message) => mlDsa44Sign(identity.secretKey, message) };
}

/** Spec Postconditions: verify with the *verifier package's own* crypto, not app-sdk's. */
function verifyWithVerifierPackage(payload: unknown, publicKeyB64: string, signatureB64: string): boolean {
  return verifierMlDsa44Verify(
    base64UrlToBytes(publicKeyB64),
    verifierCanonicalize(payload),
    base64UrlToBytes(signatureB64)
  );
}

describe('card_signing.md (live stack)', () => {
  let signer: LiveIdentity;
  let cosigner: LiveIdentity;

  beforeAll(async () => {
    // Sequential, not Promise.all: press's on-chain registerCard submission
    // uses a single gas wallet with its own nonce tracking — two concurrent
    // mints raced it into a "nonce too low" tx failure (confirmed via press
    // container logs). Not something this suite should paper over further;
    // logged as a real press-side concurrency gap in the Wave-1 report.
    signer = await mintLiveCard('card-signing-signer', { display_name: 'Card Signing Suite — Signer' });
    cosigner = await mintLiveCard('card-signing-cosigner', { display_name: 'Card Signing Suite — Cosigner' });
  }, 60_000);

  it('Phase 1-3: assembles, canonically serializes, and signs a payload', async () => {
    const payload = buildMessagePayload({
      type: 'text',
      content: { body: 'hello from the card_signing integration suite', format: 'plain' },
      recipients: [cosigner.address],
      senders: [signer.address],
      protocolVersion: '0.1',
    });

    expect(payload.senders).toEqual([signer.address]);
    expect(payload.recipients).toEqual([cosigner.address]);

    const envelope = await signMessageEnvelope(payload, [signerFrom(signer)]);
    expect(envelope.signatures).toHaveLength(1);

    const entry = envelope.signatures[0]!;
    expect(entry.public_key).toBe(bytesToBase64Url(signer.publicKey));
    expect(verifyWithVerifierPackage(envelope.payload, entry.public_key, entry.signature)).toBe(true);
  }, 30_000);

  it('Phase 2: message ID is deterministic, and app-sdk/verifier canonicalize agree byte-for-byte', () => {
    const payload = buildMessagePayload({
      type: 'text',
      content: { body: 'stable id check' },
      recipients: [cosigner.address],
      senders: [signer.address],
      protocolVersion: '0.1',
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    const id1 = messageId(payload);
    const id2 = messageId(JSON.parse(JSON.stringify(payload)) as MessagePayload);
    expect(id1).toBe(id2);

    const appSdkBytes = Buffer.from(appSdkCanonicalize(payload)).toString('hex');
    const verifierBytes = Buffer.from(verifierCanonicalize(payload)).toString('hex');
    expect(verifierBytes).toBe(appSdkBytes);
  });

  it('Phase 4: parallel co-signing — independent signers over the same canonical payload', async () => {
    const payload = buildMessagePayload({
      type: 'text',
      content: { body: 'co-signed announcement', format: 'plain' },
      recipients: [signer.address, cosigner.address],
      senders: [signer.address, cosigner.address],
      protocolVersion: '0.1',
    });

    const envelope = await signMessageEnvelope(payload, [signerFrom(signer), signerFrom(cosigner)]);
    expect(envelope.signatures).toHaveLength(2);

    for (const entry of envelope.signatures) {
      expect(verifyWithVerifierPackage(envelope.payload, entry.public_key, entry.signature)).toBe(true);
    }
    const signingKeys = envelope.signatures.map((s) => s.public_key).sort();
    const expectedKeys = [bytesToBase64Url(signer.publicKey), bytesToBase64Url(cosigner.publicKey)].sort();
    expect(signingKeys).toEqual(expectedKeys);
  }, 30_000);

  it('Edits: edit_of references the original message ID, re-signed by the same card', async () => {
    const original = buildMessagePayload({
      type: 'text',
      content: { body: 'original statement', format: 'plain' },
      recipients: [cosigner.address],
      senders: [signer.address],
      protocolVersion: '0.1',
    });
    const originalId = messageId(original);

    const edit = buildMessagePayload({
      type: 'edit',
      content: { body: 'corrected statement', format: 'plain' },
      recipients: [cosigner.address],
      senders: [signer.address],
      protocolVersion: '0.1',
      editOf: originalId,
    });
    expect(edit.edit_of).toBe(originalId);
    expect(edit.retracts).toBeUndefined();
    expect(edit.forwards).toBeUndefined();

    // "The edit is only valid if the signer's master card chains to the
    // same master as the original signer" — trivially satisfied here since
    // it's literally the same signer; a cross-signer edit is a separate,
    // chain-of-trust-dependent concern out of this spec's client-side scope.
    const editEnvelope = await signMessageEnvelope(edit, [signerFrom(signer)]);
    const entry = editEnvelope.signatures[0]!;
    expect(verifyWithVerifierPackage(editEnvelope.payload, entry.public_key, entry.signature)).toBe(true);
    expect(messageId(edit)).not.toBe(originalId);
  }, 30_000);

  it('Retractions: retracts references the original message ID with no new content', async () => {
    const original = buildMessagePayload({
      type: 'text',
      content: { body: 'statement to withdraw', format: 'plain' },
      recipients: [cosigner.address],
      senders: [signer.address],
      protocolVersion: '0.1',
    });
    const originalId = messageId(original);

    const retraction = buildMessagePayload({
      type: 'text',
      // Spec: "No new content is proposed" — an empty body is the closest
      // this SDK's typed `TextContent` (which requires `body`) gets to that.
      content: { body: '' },
      recipients: [cosigner.address],
      senders: [signer.address],
      protocolVersion: '0.1',
      retracts: originalId,
    });
    expect(retraction.retracts).toBe(originalId);

    const envelope = await signMessageEnvelope(retraction, [signerFrom(signer)]);
    const entry = envelope.signatures[0]!;
    expect(verifyWithVerifierPackage(envelope.payload, entry.public_key, entry.signature)).toBe(true);
  }, 30_000);

  it('Forwarding: a ForwardPackage unambiguously identifies original sender, forwarder, and new recipients', async () => {
    const thirdPartyRecipient = 'f'.repeat(64);

    const originalPayload = buildMessagePayload({
      type: 'text',
      content: { body: 'a message only meant for the cosigner', format: 'plain' },
      recipients: [cosigner.address],
      senders: [signer.address],
      protocolVersion: '0.1',
    });
    const originalEnvelope = await signMessageEnvelope(originalPayload, [signerFrom(signer)]);
    const originalId = messageId(originalPayload);

    // The forwarder (cosigner, a recipient of the original) forwards it on
    // to a third party not in the original's recipients array.
    const forwardPayload = buildMessagePayload({
      type: 'text',
      content: { body: 'fyi, forwarding this along', format: 'plain' },
      recipients: [thirdPartyRecipient],
      senders: [cosigner.address],
      protocolVersion: '0.1',
      forwards: originalId,
    });
    expect(forwardPayload.forwards).toBe(originalId);
    const forwardEnvelope = await signMessageEnvelope(forwardPayload, [signerFrom(cosigner)]);

    const forwardPackage = { original_envelope: originalEnvelope, forward_envelope: forwardEnvelope };

    // forwards MUST equal the canonical-payload hash of original_envelope.payload.
    expect(forwardPackage.forward_envelope.payload.forwards).toBe(messageId(forwardPackage.original_envelope.payload));

    // Both envelopes independently verify — the original's signature is
    // untouched by forwarding, and the forwarder's signature commits only
    // to the forwarding fact + new recipients, not the original content.
    const originalEntry = forwardPackage.original_envelope.signatures[0]!;
    expect(verifyWithVerifierPackage(forwardPackage.original_envelope.payload, originalEntry.public_key, originalEntry.signature)).toBe(true);

    const forwardEntry = forwardPackage.forward_envelope.signatures[0]!;
    expect(verifyWithVerifierPackage(forwardPackage.forward_envelope.payload, forwardEntry.public_key, forwardEntry.signature)).toBe(true);

    // Forwarded from / by / to are unambiguous from the two envelopes alone.
    expect(originalEntry.public_key).toBe(bytesToBase64Url(signer.publicKey)); // forwarded from
    expect(forwardEntry.public_key).toBe(bytesToBase64Url(cosigner.publicKey)); // forwarded by
    expect(forwardPackage.forward_envelope.payload.recipients).toEqual([thirdPartyRecipient]); // forwarded to
  }, 30_000);

  it('Error path: rejects a payload with more than one of edit_of/retracts/forwards set', () => {
    expect(() =>
      buildMessagePayload({
        type: 'text',
        content: { body: 'invalid' },
        recipients: [cosigner.address],
        senders: [signer.address],
        protocolVersion: '0.1',
        editOf: 'x',
        retracts: 'y',
      })
    ).toThrow();
  });
});
