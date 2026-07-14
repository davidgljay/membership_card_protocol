/**
 * Shadow Matrix account derivation (matrix_encryption.md §3).
 *
 * `deriveMatrixUserId`/`verifyMatrixUserIdBinding` here are the TypeScript
 * mirror of the Python `derive_matrix_user_id`/`verify_matrix_user_id_binding`
 * in `wallet-service/matrix-policy-module/src/matrix_policy_module/attestation.py`
 * — both implementations must agree on every input (byte-identical output
 * for the same `card_hash`/`server_name`). There is deliberately no inverse
 * — see matrix_encryption.md §3's "Honest limit" section: a Matrix user ID
 * alone can never be turned back into a card_hash, by design. Do not add a
 * `matrixUserIdToCardHash` or similar function here.
 */

import { keccak_256 } from '@noble/hashes/sha3';

const SHADOW_ACCOUNT_DOMAIN_TAG = 'matrix-shadow-account-v1';

function hexToBytes(value: string): Uint8Array {
  const hex = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
  return Buffer.from(hex, 'hex');
}

/**
 * keccak256(card_hash || domain_tag || server_name) — domain-separated,
 * matrix_encryption.md §3.
 */
export function shadowAccountCommitment(cardHash: string, serverName: string): string {
  const data = Buffer.concat([
    hexToBytes(cardHash),
    Buffer.from(SHADOW_ACCOUNT_DOMAIN_TAG, 'utf-8'),
    Buffer.from(serverName, 'utf-8'),
  ]);
  return '0x' + Buffer.from(keccak_256(data)).toString('hex');
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
  serverName: string,
): boolean {
  return deriveMatrixUserId(candidateCardHash, serverName) === matrixUserId;
}
