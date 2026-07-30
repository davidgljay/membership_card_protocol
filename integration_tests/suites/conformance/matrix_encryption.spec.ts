/**
 * `specs/object_specs/matrix_encryption.md` conformance — Phase 5 Step 5.2
 * (object-spec coverage).
 *
 * Matrix message encryption envelope shape, shadow-account derivation, and
 * sender-binding verification. Unlike process specs, this suite does NOT
 * require a live Matrix room or signature attestation flow — it's purely
 * about the invariants of the pure functions that underpin them. No live
 * stack writes (no mintLiveCard, no Synapse interaction), just cryptography.
 *
 * ────────────────────────────────────────────────────────────────────────
 * KEY TEST: §3 Shadow Matrix Account Derivation — Cross-Language Agreement
 * ────────────────────────────────────────────────────────────────────────
 *
 * The TypeScript implementation (app-sdk/packages/app-sdk/src/matrix/
 * account-id.ts) and the Python mirror (wallet-service/matrix-policy-module/
 * src/matrix_policy_module/attestation.py) must produce byte-identical output
 * for the same inputs. This suite invokes both and asserts exact agreement.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import {
  deriveMatrixUserId,
  verifyMatrixUserIdBinding,
  shadowAccountCommitment,
  mlDsa44GenerateKeypair,
  mlDsa44Sign,
  keccak256,
  canonicalize,
} from '@membership-card-protocol/app-sdk';
import { mlDsa44Verify } from '@membership-card-protocol/verifier';

// Fixture pair shared with wallet-service/test/account-id.test.ts
// Cross-checked against Python implementation before hardcoding
const CARD_HASH_A = '0x' + 'ab'.repeat(32);
const CARD_HASH_B = '0x' + '01'.repeat(32);
const SERVER_NAME = 'matrix.internal';
const OTHER_SERVER_NAME = 'example.org';

const EXPECTED_MATRIX_USER_ID_A =
  '@card_5571cd3464994aea35d1ca6cbba4b48c7f895e8249b503eb47f46607a34c2c81:matrix.internal';

/**
 * Invokes the Python implementation of derive_matrix_user_id via the venv
 * at wallet-service/matrix-policy-module/.venv.
 */
function derivePythonMatrixUserId(cardHash: string, serverName: string): string {
  const pythonVenv = '/Users/davidjay/Projects/Claude/card_protocol/wallet-service/matrix-policy-module/.venv/bin/python3';
  const code = `from matrix_policy_module.attestation import derive_matrix_user_id; print(derive_matrix_user_id('${cardHash}', '${serverName}'))`;
  const result = execSync(`${pythonVenv} -c "${code}"`, { encoding: 'utf-8' }).trim();
  return result;
}

describe('matrix_encryption.md (object-spec conformance)', () => {
  describe('§3 Shadow Matrix Account Derivation', () => {
    describe('Cross-language parity: TS ↔ Python', () => {
      it('TypeScript deriveMatrixUserId matches known-good Python fixture', () => {
        expect(deriveMatrixUserId(CARD_HASH_A, SERVER_NAME)).toBe(EXPECTED_MATRIX_USER_ID_A);
      });

      it('TypeScript and Python implementations produce identical output for fixture A', () => {
        const tsResult = deriveMatrixUserId(CARD_HASH_A, SERVER_NAME);
        const pythonResult = derivePythonMatrixUserId(CARD_HASH_A, SERVER_NAME);
        expect(tsResult).toBe(pythonResult);
      });

      it('TypeScript and Python implementations produce identical output for fixture B', () => {
        const tsResult = deriveMatrixUserId(CARD_HASH_B, SERVER_NAME);
        const pythonResult = derivePythonMatrixUserId(CARD_HASH_B, SERVER_NAME);
        expect(tsResult).toBe(pythonResult);
      });

      it('TypeScript and Python implementations agree with different server names', () => {
        const tsResult = deriveMatrixUserId(CARD_HASH_A, OTHER_SERVER_NAME);
        const pythonResult = derivePythonMatrixUserId(CARD_HASH_A, OTHER_SERVER_NAME);
        expect(tsResult).toBe(pythonResult);
      });
    });

    describe('Forward verification (no inverse)', () => {
      it('verifyMatrixUserIdBinding returns true for a matching triple', () => {
        const matrixUserId = deriveMatrixUserId(CARD_HASH_A, SERVER_NAME);
        expect(verifyMatrixUserIdBinding(CARD_HASH_A, matrixUserId, SERVER_NAME)).toBe(true);
      });

      it('verifyMatrixUserIdBinding returns false for a different card_hash (negative case)', () => {
        const matrixUserId = deriveMatrixUserId(CARD_HASH_A, SERVER_NAME);
        expect(verifyMatrixUserIdBinding(CARD_HASH_B, matrixUserId, SERVER_NAME)).toBe(false);
      });

      it('verifyMatrixUserIdBinding returns false for a different server_name', () => {
        const matrixUserId = deriveMatrixUserId(CARD_HASH_A, SERVER_NAME);
        expect(verifyMatrixUserIdBinding(CARD_HASH_A, matrixUserId, OTHER_SERVER_NAME)).toBe(false);
      });

      it('verifyMatrixUserIdBinding returns false when comparing two different cards\' IDs', () => {
        const idA = deriveMatrixUserId(CARD_HASH_A, SERVER_NAME);
        const idB = deriveMatrixUserId(CARD_HASH_B, SERVER_NAME);
        // Card B's ID should not verify against Card A
        expect(verifyMatrixUserIdBinding(CARD_HASH_A, idB, SERVER_NAME)).toBe(false);
        // Card A's ID should not verify against Card B
        expect(verifyMatrixUserIdBinding(CARD_HASH_B, idA, SERVER_NAME)).toBe(false);
      });
    });

    describe('Domain separation', () => {
      it('shadowAccountCommitment produces different results for different server_names', () => {
        const commitment = shadowAccountCommitment(CARD_HASH_A, SERVER_NAME);
        const commitmentOtherServer = shadowAccountCommitment(CARD_HASH_A, OTHER_SERVER_NAME);
        expect(commitment).not.toBe(commitmentOtherServer);
      });

      it('deriveMatrixUserId is deterministic and produces lowercase hex', () => {
        const first = deriveMatrixUserId(CARD_HASH_A, SERVER_NAME);
        const second = deriveMatrixUserId(CARD_HASH_A, SERVER_NAME);
        expect(first).toBe(second);
        expect(first).toMatch(/^@card_[0-9a-f]+:matrix\.internal$/);
      });
    });
  });

  describe('§4 Sender-Binding Check', () => {
    /**
     * Helper to canonicalize a payload and verify an ML-DSA-44 signature
     * (both checks from the spec's `on_receive` pseudocode).
     */
    function checkSignatureValidity(payload: unknown, publicKeyB64: string, signatureB64: string): boolean {
      // This would use base64UrlToBytes in a real app; for this test,
      // we control both sides and use raw bytes throughout.
      try {
        const publicKeyBytes = Buffer.from(publicKeyB64, 'base64');
        const signatureBytes = Buffer.from(signatureB64, 'base64');
        return mlDsa44Verify(publicKeyBytes, canonicalize(payload), signatureBytes);
      } catch {
        return false;
      }
    }

    describe('Check 1: Signature validity', () => {
      it('accepts a genuinely valid ML-DSA-44 signature', () => {
        const keypair = mlDsa44GenerateKeypair();
        const payload = {
          type: 'text',
          content: { body: 'hello from matrix', format: 'plain' },
          protocol_version: '0.1',
          timestamp: new Date().toISOString(),
        };

        const signature = mlDsa44Sign(keypair.secretKey, canonicalize(payload));
        const publicKeyB64 = Buffer.from(keypair.publicKey).toString('base64');
        const signatureB64 = Buffer.from(signature).toString('base64');

        expect(checkSignatureValidity(payload, publicKeyB64, signatureB64)).toBe(true);
      });

      it('rejects a signature over corrupted payload (Check 1 failure: invalid_signature)', () => {
        const keypair = mlDsa44GenerateKeypair();
        const payload = {
          type: 'text',
          content: { body: 'original message', format: 'plain' },
          protocol_version: '0.1',
          timestamp: '2026-01-01T00:00:00Z',
        };

        const signature = mlDsa44Sign(keypair.secretKey, canonicalize(payload));

        // Corrupt the payload
        const corruptedPayload = {
          ...payload,
          content: { body: 'tampered message', format: 'plain' },
        };

        const publicKeyB64 = Buffer.from(keypair.publicKey).toString('base64');
        const signatureB64 = Buffer.from(signature).toString('base64');

        expect(checkSignatureValidity(corruptedPayload, publicKeyB64, signatureB64)).toBe(false);
      });

      it('rejects a signature from a different keypair (Check 1 failure: invalid_signature)', () => {
        const signerKeypair = mlDsa44GenerateKeypair();
        const differentKeypair = mlDsa44GenerateKeypair();

        const payload = {
          type: 'text',
          content: { body: 'test message', format: 'plain' },
          protocol_version: '0.1',
          timestamp: '2026-01-01T00:00:00Z',
        };

        // Sign with first keypair
        const signature = mlDsa44Sign(signerKeypair.secretKey, canonicalize(payload));

        // Try to verify with second keypair's public key
        const publicKeyB64 = Buffer.from(differentKeypair.publicKey).toString('base64');
        const signatureB64 = Buffer.from(signature).toString('base64');

        expect(checkSignatureValidity(payload, publicKeyB64, signatureB64)).toBe(false);
      });
    });

    describe('Check 2: Sender-binding (distinct from invalid_signature)', () => {
      it('accepts a message validly signed by the sender\'s own card', () => {
        const senderKeypair = mlDsa44GenerateKeypair();
        const senderCardHash = '0x' + keccak256(senderKeypair.publicKey);
        const senderMatrixUserId = deriveMatrixUserId(senderCardHash, SERVER_NAME);

        const payload = {
          type: 'text',
          content: { body: 'sender binding check', format: 'plain' },
          protocol_version: '0.1',
          timestamp: new Date().toISOString(),
        };

        const signature = mlDsa44Sign(senderKeypair.secretKey, canonicalize(payload));
        const publicKeyB64 = Buffer.from(senderKeypair.publicKey).toString('base64');
        const signatureB64 = Buffer.from(signature).toString('base64');

        // Check 1: signature is valid
        expect(checkSignatureValidity(payload, publicKeyB64, signatureB64)).toBe(true);

        // Check 2: sender binding is correct
        const recoveredCardHash = '0x' + keccak256(senderKeypair.publicKey);
        expect(verifyMatrixUserIdBinding(recoveredCardHash, senderMatrixUserId, SERVER_NAME)).toBe(true);
      });

      it('rejects a message signed by a different card (Check 2 failure: sender_binding_mismatch, not invalid_signature)', () => {
        // Simulate the worked example from §4: a compromised client
        // crafts a message signed by card B, but posts it as card A.

        // Card A (the sender in the Matrix event)
        const cardAKeypair = mlDsa44GenerateKeypair();
        const cardAHash = '0x' + keccak256(cardAKeypair.publicKey);
        const cardAMatrixUserId = deriveMatrixUserId(cardAHash, SERVER_NAME);

        // Card B (actually signed the payload)
        const cardBKeypair = mlDsa44GenerateKeypair();
        const cardBHash = '0x' + keccak256(cardBKeypair.publicKey);

        const payload = {
          type: 'text',
          content: { body: 'compromised client attack', format: 'plain' },
          protocol_version: '0.1',
          timestamp: new Date().toISOString(),
        };

        // Sign with Card B's key
        const signature = mlDsa44Sign(cardBKeypair.secretKey, canonicalize(payload));
        const publicKeyB64 = Buffer.from(cardBKeypair.publicKey).toString('base64');
        const signatureB64 = Buffer.from(signature).toString('base64');

        // Check 1: the signature IS valid (it's a genuine ML-DSA-44 signature)
        expect(checkSignatureValidity(payload, publicKeyB64, signatureB64)).toBe(true);

        // Check 2: but the signature is from Card B, not Card A
        // The receiving client recovers Card B's hash from the verified signature,
        // then checks if it matches the claimed sender (Card A's Matrix ID)
        expect(verifyMatrixUserIdBinding(cardBHash, cardAMatrixUserId, SERVER_NAME)).toBe(false);
        // The correct Matrix ID for Card B would be different
        const cardBMatrixUserId = deriveMatrixUserId(cardBHash, SERVER_NAME);
        expect(cardBMatrixUserId).not.toBe(cardAMatrixUserId);
      });

      it('distinguishes sender_binding_mismatch from invalid_signature in the attack scenario', () => {
        // Same compromised-client scenario, but explicit about the two rejection reasons

        const attackerKeypair = mlDsa44GenerateKeypair();
        const targetKeypair = mlDsa44GenerateKeypair();

        const attackerCardHash = '0x' + keccak256(attackerKeypair.publicKey);
        const targetCardHash = '0x' + keccak256(targetKeypair.publicKey);

        const targetMatrixUserId = deriveMatrixUserId(targetCardHash, SERVER_NAME);

        const payload = {
          type: 'text',
          content: { body: 'identity drift attack', format: 'plain' },
          protocol_version: '0.1',
          timestamp: new Date().toISOString(),
        };

        // Attacker signs with their own key (not compromising the target)
        const signature = mlDsa44Sign(attackerKeypair.secretKey, canonicalize(payload));
        const publicKeyB64 = Buffer.from(attackerKeypair.publicKey).toString('base64');
        const signatureB64 = Buffer.from(signature).toString('base64');

        // Check 1: signature is genuinely valid (from the attacker's own keypair)
        const check1Pass = checkSignatureValidity(payload, publicKeyB64, signatureB64);
        expect(check1Pass).toBe(true);

        // Check 2: but if this message were posted under the target's Matrix ID,
        // it would fail sender-binding (the signature is from the attacker, not the target)
        const check2Pass = verifyMatrixUserIdBinding(attackerCardHash, targetMatrixUserId, SERVER_NAME);
        expect(check2Pass).toBe(false);

        // These are two *distinct* rejection reasons; a correct implementation
        // must distinguish them (as per §4's note on distinct rejection reasons).
        // check1Pass is true but check2Pass is false — the rejection is
        // "sender_binding_mismatch", not "invalid_signature".
      });
    });
  });

  describe('§2 Envelope shape (differences from messaging_protocol.md)', () => {
    it('constructs a room-message envelope without recipients/senders fields', () => {
      const roomPayload = {
        type: 'text',
        content: { body: 'meeting moved to 3pm', format: 'plain' },
        protocol_version: '0.1',
        timestamp: '2026-07-10T18:04:00Z',
        // Deliberately no recipients or senders — these are omitted in room messages
      };

      // The payload should be canonicalizable (RFC 8785)
      const canonical = canonicalize(roomPayload);
      expect(canonical).toBeInstanceOf(Uint8Array);
      expect(canonical.length).toBeGreaterThan(0);

      // It should be signable
      const keypair = mlDsa44GenerateKeypair();
      const signature = mlDsa44Sign(keypair.secretKey, canonical);
      expect(signature).toBeInstanceOf(Uint8Array);
      expect(signature.length).toBeGreaterThan(0);
    });

    it('optionally includes matrix_event_id in the payload', () => {
      const roomPayloadWithEventId = {
        type: 'text',
        content: { body: 'message with event reference', format: 'plain' },
        matrix_event_id: '$event-id-here:matrix.internal',
        protocol_version: '0.1',
        timestamp: '2026-07-10T18:04:00Z',
      };

      const canonical = canonicalize(roomPayloadWithEventId);
      expect(canonical).toBeInstanceOf(Uint8Array);

      const keypair = mlDsa44GenerateKeypair();
      const signature = mlDsa44Sign(keypair.secretKey, canonical);
      expect(signature).toBeInstanceOf(Uint8Array);
    });

    it('assembles a complete Card-Signature Envelope (§2 worked example shape)', () => {
      const keypair = mlDsa44GenerateKeypair();

      const payload = {
        type: 'text',
        content: { body: 'meeting moved to 3pm', format: 'plain' },
        protocol_version: '0.1',
        timestamp: '2026-07-10T18:04:00Z',
      };

      const signature = mlDsa44Sign(keypair.secretKey, canonicalize(payload));

      // Construct the full envelope as per §2's worked example
      const envelope = {
        payload,
        signatures: [
          {
            public_key: Buffer.from(keypair.publicKey).toString('base64'),
            signature: Buffer.from(signature).toString('base64'),
          },
        ],
      };

      // Verify structure matches §2's schema
      expect(envelope.payload.type).toBe('text');
      expect(envelope.payload.content.body).toBe('meeting moved to 3pm');
      expect(envelope.payload.protocol_version).toBe('0.1');
      expect(envelope.signatures).toHaveLength(1);
      expect(envelope.signatures[0]!.public_key).toBeDefined();
      expect(envelope.signatures[0]!.signature).toBeDefined();

      // Verify the signature verifies
      const publicKeyBytes = Buffer.from(envelope.signatures[0]!.public_key, 'base64');
      const signatureBytes = Buffer.from(envelope.signatures[0]!.signature, 'base64');
      expect(mlDsa44Verify(publicKeyBytes, canonicalize(payload), signatureBytes)).toBe(true);
    });

    it('preserves message-type taxonomy from messaging_protocol.md (text, reply, edit, etc.)', () => {
      const keypair = mlDsa44GenerateKeypair();

      // Different message types, all valid in room messages (per §2)
      const messageTypes = ['text', 'reply', 'edit', 'reaction'];

      for (const msgType of messageTypes) {
        const payload = {
          type: msgType,
          content: msgType === 'reaction' ? { emoji: '👍' } : { body: `a ${msgType} message`, format: 'plain' },
          protocol_version: '0.1',
          timestamp: new Date().toISOString(),
        };

        const signature = mlDsa44Sign(keypair.secretKey, canonicalize(payload));
        expect(signature).toBeInstanceOf(Uint8Array);
        expect(signature.length).toBeGreaterThan(0);
      }
    });
  });
});
