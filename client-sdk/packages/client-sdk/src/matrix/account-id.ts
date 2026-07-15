/**
 * Shadow Matrix account derivation (matrix_encryption.md §3).
 *
 * Port of `wallet-service/src/matrix/account-id.ts` into `client-sdk` (Matrix
 * Phase 5, Step 17a) — `matrix/attestation.ts` needs this locally, since a
 * client building its own join attestation has to compute the shadow-account
 * `matrix_user_id` it's about to join with, without a round trip to
 * `wallet-service`. All three implementations of this derivation —
 * `wallet-service/src/matrix/account-id.ts`, the Python mirror in
 * `wallet-service/matrix-policy-module/src/matrix_policy_module/attestation.py`
 * (`derive_matrix_user_id`), and this one — must agree on every input
 * (byte-identical output for the same `card_hash`/`server_name`). See
 * `wallet-service/test/account-id.test.ts`'s cross-language fixture
 * (`CARD_HASH_A`/`EXPECTED_MATRIX_USER_ID_A`); this package's own
 * `test/matrix/account-id.test.ts` asserts the exact same fixture pair
 * produces the exact same output here.
 *
 * Differs from the `wallet-service` copy only in reusing this package's own
 * `keccak256` (`crypto/hashes.ts`) instead of a separate direct
 * `@noble/hashes` import — otherwise the algorithm is identical.
 *
 * There is deliberately no inverse — see matrix_encryption.md §3's "Honest
 * limit" section: a Matrix user ID alone can never be turned back into a
 * card_hash, by design. Do not add a `matrixUserIdToCardHash` or similar
 * function here.
 */

import { keccak256 } from '../crypto/hashes.js';

const SHADOW_ACCOUNT_DOMAIN_TAG = 'matrix-shadow-account-v1';

/**
 * Exported (not just an internal helper) so `matrix/attestation.ts` can
 * convert a hex `card_hash` into the raw bytes it needs for the payload's
 * base64url-encoded `card_hash` field, without a second, divergent hex-parse
 * implementation.
 */
export function hexToBytes(value: string): Uint8Array {
  const hex = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/**
 * keccak256(card_hash || domain_tag || server_name) — domain-separated,
 * matrix_encryption.md §3.
 */
export function shadowAccountCommitment(cardHash: string, serverName: string): string {
  const data = concatBytes(
    hexToBytes(cardHash),
    new TextEncoder().encode(SHADOW_ACCOUNT_DOMAIN_TAG),
    new TextEncoder().encode(serverName)
  );
  return '0x' + keccak256(data);
}

/**
 * Derives the one Matrix user ID a given card_hash may claim on a given
 * homeserver, per matrix_encryption.md §3.
 */
export function deriveMatrixUserId(cardHash: string, serverName: string): string {
  const commitment = shadowAccountCommitment(cardHash, serverName);
  const commitmentHex = (commitment.startsWith('0x') ? commitment.slice(2) : commitment).toLowerCase();
  return `@card_${commitmentHex}:${serverName}`;
}

/**
 * Forward recomputation only — no inverse exists or should be added
 * (matrix_encryption.md §3). Confirms a candidate card_hash could have
 * produced the given matrix_user_id on the given server; does not (and
 * cannot) recover a card_hash from a matrix_user_id alone.
 */
export function verifyMatrixUserIdBinding(
  candidateCardHash: string,
  matrixUserId: string,
  serverName: string
): boolean {
  return deriveMatrixUserId(candidateCardHash, serverName) === matrixUserId;
}
