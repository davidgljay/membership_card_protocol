import { describe, it, expect } from 'vitest';
import { buildJoinAttestation, JOIN_ATTESTATION_EVENT_CONTENT_KEY } from '../../src/matrix/attestation.js';
import { deriveMatrixUserId } from '../../src/matrix/account-id.js';
import { mlDsa44GenerateKeypair, mlDsa44Verify } from '../../src/crypto/mldsa.js';
import { canonicalize } from '../../src/crypto/canonicalize.js';
import { keccak256 } from '../../src/crypto/hashes.js';
import { base64UrlToBytes, bytesToBase64Url } from '../../src/util/base64url.js';

const ROOM_ID = '!card-gated-room:matrix.internal';
const SERVER_NAME = 'matrix.internal';
const FIXED_NOW = () => '2026-07-14T12:00:00.000Z';

describe('buildJoinAttestation', () => {
  it('produces a payload whose card_hash matches keccak256(publicKey) of the signing key', () => {
    const { secretKey, publicKey } = mlDsa44GenerateKeypair();
    const envelope = buildJoinAttestation(secretKey, ROOM_ID, SERVER_NAME, FIXED_NOW);

    const expectedCardHashBytes = hexToBytes(keccak256(publicKey));
    expect(envelope.payload.card_hash).toBe(bytesToBase64Url(expectedCardHashBytes));
    expect(base64UrlToBytes(envelope.payload.card_hash)).toEqual(expectedCardHashBytes);
  });

  it("produces a payload whose matrix_user_id matches deriveMatrixUserId(card_hash, server_name)", () => {
    const { secretKey, publicKey } = mlDsa44GenerateKeypair();
    const envelope = buildJoinAttestation(secretKey, ROOM_ID, SERVER_NAME, FIXED_NOW);

    const cardHashHex = '0x' + keccak256(publicKey);
    expect(envelope.payload.matrix_user_id).toBe(deriveMatrixUserId(cardHashHex, SERVER_NAME));
  });

  it('sets type, room_id, server_name, protocol_version, and timestamp as specified', () => {
    const { secretKey } = mlDsa44GenerateKeypair();
    const envelope = buildJoinAttestation(secretKey, ROOM_ID, SERVER_NAME, FIXED_NOW);

    expect(envelope.payload.type).toBe('room_join_attestation');
    expect(envelope.payload.room_id).toBe(ROOM_ID);
    expect(envelope.payload.server_name).toBe(SERVER_NAME);
    expect(envelope.payload.protocol_version).toBe('0.1');
    expect(envelope.payload.timestamp).toBe(FIXED_NOW());
  });

  it('defaults timestamp to the current time when `now` is not supplied', () => {
    const { secretKey } = mlDsa44GenerateKeypair();
    const before = Date.now();
    const envelope = buildJoinAttestation(secretKey, ROOM_ID, SERVER_NAME);
    const after = Date.now();

    const timestampMs = new Date(envelope.payload.timestamp).getTime();
    expect(timestampMs).toBeGreaterThanOrEqual(before);
    expect(timestampMs).toBeLessThanOrEqual(after);
  });

  it('the signature verifies correctly against the canonical payload', () => {
    const { secretKey, publicKey } = mlDsa44GenerateKeypair();
    const envelope = buildJoinAttestation(secretKey, ROOM_ID, SERVER_NAME, FIXED_NOW);

    const [sig] = envelope.signatures;
    expect(sig).toBeDefined();
    expect(sig!.public_key).toBe(bytesToBase64Url(publicKey));

    const verified = mlDsa44Verify(
      base64UrlToBytes(sig!.public_key),
      canonicalize(envelope.payload),
      base64UrlToBytes(sig!.signature)
    );
    expect(verified).toBe(true);
  });

  it('rejects verification when the public key does not match the signing key', () => {
    const { secretKey } = mlDsa44GenerateKeypair();
    const { publicKey: wrongPublicKey } = mlDsa44GenerateKeypair();
    const envelope = buildJoinAttestation(secretKey, ROOM_ID, SERVER_NAME, FIXED_NOW);
    const [sig] = envelope.signatures;

    const verified = mlDsa44Verify(wrongPublicKey, canonicalize(envelope.payload), base64UrlToBytes(sig!.signature));
    expect(verified).toBe(false);
  });

  it('a tampered matrix_user_id field causes signature verification to fail', () => {
    // This is the explicit done-when criterion from the Step 17a plan entry:
    // a client must not be able to accidentally or maliciously claim a
    // different card's shadow account by mutating the payload post-signing
    // — the signature has to cover matrix_user_id, or this would pass.
    const { secretKey, publicKey } = mlDsa44GenerateKeypair();
    const envelope = buildJoinAttestation(secretKey, ROOM_ID, SERVER_NAME, FIXED_NOW);
    const [sig] = envelope.signatures;

    const tamperedPayload = {
      ...envelope.payload,
      matrix_user_id: '@card_' + '0'.repeat(64) + ':' + SERVER_NAME,
    };

    const verified = mlDsa44Verify(
      base64UrlToBytes(sig!.public_key),
      canonicalize(tamperedPayload),
      base64UrlToBytes(sig!.signature)
    );
    expect(verified).toBe(false);
    // Sanity: the untampered payload still verifies against the same signature.
    expect(
      mlDsa44Verify(publicKey, canonicalize(envelope.payload), base64UrlToBytes(sig!.signature))
    ).toBe(true);
  });

  it('a tampered card_hash field causes signature verification to fail', () => {
    const { secretKey } = mlDsa44GenerateKeypair();
    const envelope = buildJoinAttestation(secretKey, ROOM_ID, SERVER_NAME, FIXED_NOW);
    const [sig] = envelope.signatures;

    const tamperedPayload = { ...envelope.payload, card_hash: bytesToBase64Url(new Uint8Array(32)) };

    const verified = mlDsa44Verify(
      base64UrlToBytes(sig!.public_key),
      canonicalize(tamperedPayload),
      base64UrlToBytes(sig!.signature)
    );
    expect(verified).toBe(false);
  });

  it('exports the spec-mandated event-content key for the join event attachment', () => {
    expect(JOIN_ATTESTATION_EVENT_CONTENT_KEY).toBe('io.cardprotocol.join_attestation');
  });

  it('produces different attestations (different matrix_user_id/card_hash) for different cards', () => {
    const cardA = mlDsa44GenerateKeypair();
    const cardB = mlDsa44GenerateKeypair();
    const envelopeA = buildJoinAttestation(cardA.secretKey, ROOM_ID, SERVER_NAME, FIXED_NOW);
    const envelopeB = buildJoinAttestation(cardB.secretKey, ROOM_ID, SERVER_NAME, FIXED_NOW);

    expect(envelopeA.payload.card_hash).not.toBe(envelopeB.payload.card_hash);
    expect(envelopeA.payload.matrix_user_id).not.toBe(envelopeB.payload.matrix_user_id);
  });
});

function hexToBytes(value: string): Uint8Array {
  const hex = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
