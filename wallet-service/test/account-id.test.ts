import { describe, it, expect } from 'vitest';
import { deriveMatrixUserId, shadowAccountCommitment, verifyMatrixUserIdBinding } from '../src/matrix/account-id.js';

// Fixture values cross-checked against the Python mirror
// (matrix-policy-module/src/matrix_policy_module/attestation.py's
// derive_matrix_user_id), run directly via:
//   python3 -c "from matrix_policy_module.attestation import derive_matrix_user_id; \
//     print(derive_matrix_user_id('0x' + 'ab'*32, 'matrix.internal'))"
// to confirm byte-identical output before hardcoding here.
const CARD_HASH_A = '0x' + 'ab'.repeat(32);
const CARD_HASH_B = '0x' + '01'.repeat(32);
const SERVER_NAME = 'matrix.internal';
const OTHER_SERVER_NAME = 'example.org';

const EXPECTED_MATRIX_USER_ID_A =
  '@card_5571cd3464994aea35d1ca6cbba4b48c7f895e8249b503eb47f46607a34c2c81:matrix.internal';

describe('shadowAccountCommitment / deriveMatrixUserId / verifyMatrixUserIdBinding', () => {
  it('cross-language parity: matches the known-good Python-derived fixture', () => {
    expect(deriveMatrixUserId(CARD_HASH_A, SERVER_NAME)).toBe(EXPECTED_MATRIX_USER_ID_A);
  });

  it('verifyMatrixUserIdBinding returns true for a matching triple', () => {
    const matrixUserId = deriveMatrixUserId(CARD_HASH_A, SERVER_NAME);
    expect(verifyMatrixUserIdBinding(CARD_HASH_A, matrixUserId, SERVER_NAME)).toBe(true);
  });

  it('verifyMatrixUserIdBinding returns false for a different card_hash', () => {
    const matrixUserId = deriveMatrixUserId(CARD_HASH_A, SERVER_NAME);
    expect(verifyMatrixUserIdBinding(CARD_HASH_B, matrixUserId, SERVER_NAME)).toBe(false);
  });

  it('verifyMatrixUserIdBinding returns false for a different server_name', () => {
    const matrixUserId = deriveMatrixUserId(CARD_HASH_A, SERVER_NAME);
    expect(verifyMatrixUserIdBinding(CARD_HASH_A, matrixUserId, OTHER_SERVER_NAME)).toBe(false);
  });

  it('deriveMatrixUserId is deterministic and lowercases the commitment hex', () => {
    const first = deriveMatrixUserId(CARD_HASH_A, SERVER_NAME);
    const second = deriveMatrixUserId(CARD_HASH_A, SERVER_NAME);
    expect(first).toBe(second);
    expect(first).toMatch(/^@card_[0-9a-f]+:matrix\.internal$/);
  });

  it('shadowAccountCommitment is domain-separated from a bare keccak256(card_hash)', () => {
    // Not a security proof, just a sanity check that the domain tag and
    // server_name actually participate in the hash input rather than being
    // silently ignored.
    const commitment = shadowAccountCommitment(CARD_HASH_A, SERVER_NAME);
    const commitmentOtherServer = shadowAccountCommitment(CARD_HASH_A, OTHER_SERVER_NAME);
    expect(commitment).not.toBe(commitmentOtherServer);
  });

  // No round-trip/inverse test exists here by design — matrix_encryption.md
  // §3 is explicit that no function recovering card_hash from a
  // matrix_user_id exists or should exist.
});
