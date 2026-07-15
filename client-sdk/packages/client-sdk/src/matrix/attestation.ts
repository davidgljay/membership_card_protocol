import { PROTOCOL_VERSION_0_1 } from '@membership-card-protocol/verifier';
import { canonicalize } from '../crypto/canonicalize.js';
import { mlDsa44GetPublicKey, mlDsa44Sign } from '../crypto/mldsa.js';
import { bytesToBase64Url } from '../util/base64url.js';
import type { EnvelopeSignatureEntry } from '../messaging/envelope.js';
import { deriveMatrixUserId, hexToBytes } from './account-id.js';
import { keccak256 } from '../crypto/hashes.js';

/**
 * Join-attestation construction (Matrix Phase 5, Step 17a —
 * `specs/process_specs/matrix_join_attestation_and_revocation.md §1`).
 *
 * A card holder's client signs a short-lived statement asserting which card
 * is about to join which room, under which shadow Matrix account, so the
 * Synapse-side policy module (`wallet-service/matrix-policy-module/src/matrix_policy_module/attestation.py`
 * — the authoritative reference for the exact shape verified server-side)
 * can authorize the join without a live call back to `wallet-service`. Wire
 * transport is resolved (spec §1): the caller attaches this envelope under
 * the custom `io.cardprotocol.join_attestation` key in the `m.room.member`
 * join event's own content — that attachment step is this function's
 * caller's responsibility (Step 18, Megolm session management), not this
 * module's.
 *
 * Reuses the exact same signing primitives every other envelope in this SDK
 * uses (`canonicalize`, `mlDsa44Sign`, `bytesToBase64Url` — the same call
 * site `messaging/envelope.ts`'s `signMessageEnvelopeSync` uses), following
 * the pattern already established by `matrix/discovery.ts`'s
 * `buildRoomDiscoveryEnvelope`: a minimal, self-contained, non-`MessageType`
 * payload, canonicalized and signed the same way, rather than a new signing
 * path. Unlike `buildRoomDiscoveryEnvelope`'s payload (no card-identifying
 * fields at all — that function's whole point is an anonymous chain-walk
 * proof), this payload's shape is spec-mandated and card/room/account-bound:
 * `type`, `card_hash`, `matrix_user_id`, `room_id`, `server_name`,
 * `protocol_version`, `timestamp` — see the spec excerpt above.
 *
 * `card_hash` is derived here, not passed in — it's always
 * `keccak256(recipient_pubkey)` of the signing keypair's own public key
 * (same relationship `discovery.ts`'s envelope-signer address has to its own
 * pubkey), so there is no way for a caller to pass a `card_hash` that
 * doesn't match the key that's about to sign the envelope. `matrix_user_id`
 * is likewise derived here via {@link deriveMatrixUserId} rather than
 * accepted as a parameter, for the same reason: the whole point of the
 * server-side check (`verifyMatrixUserIdBinding`) is that a client cannot
 * claim a shadow account it doesn't actually own, and a client that could
 * pass an arbitrary `matrix_user_id` into this function could construct an
 * attestation that's internally consistent but wrong (it would just fail
 * verification server-side) — deriving it here instead makes that class of
 * caller mistake structurally impossible rather than merely rejected later.
 */

export const JOIN_ATTESTATION_EVENT_CONTENT_KEY = 'io.cardprotocol.join_attestation';

export interface JoinAttestationPayload {
  type: 'room_join_attestation';
  /** base64url(keccak256(recipient_pubkey)) — included for readability, not trusted server-side. */
  card_hash: string;
  /** The shadow-account Matrix ID this client is about to join with. */
  matrix_user_id: string;
  /** Matrix room ID being joined. */
  room_id: string;
  /** Homeserver domain; must match the policy module's configured `matrix_server_name`. */
  server_name: string;
  protocol_version: string;
  /** ISO 8601. */
  timestamp: string;
}

export interface JoinAttestationEnvelope {
  payload: JoinAttestationPayload;
  signatures: EnvelopeSignatureEntry[];
}

/**
 * Builds and signs a join attestation for `roomId` on `serverName`, using
 * `cardSecretKey` (the card's own ML-DSA-44 secret key — the same key used
 * elsewhere in this SDK to sign message envelopes and the room-discovery
 * statement).
 *
 * @param cardSecretKey - The signing card's ML-DSA-44 secret key.
 * @param roomId - Matrix room ID being joined.
 * @param serverName - Homeserver domain the joining account lives on.
 * @param now - Injectable timestamp source, primarily for testing. Defaults
 *   to `new Date().toISOString()`.
 */
export function buildJoinAttestation(
  cardSecretKey: Uint8Array,
  roomId: string,
  serverName: string,
  now: () => string = () => new Date().toISOString()
): JoinAttestationEnvelope {
  const publicKey = mlDsa44GetPublicKey(cardSecretKey);
  const cardHashHex = keccak256(publicKey);
  const cardHashBytes = hexToBytes(cardHashHex);
  const matrixUserId = deriveMatrixUserId('0x' + cardHashHex, serverName);

  const payload: JoinAttestationPayload = {
    type: 'room_join_attestation',
    card_hash: bytesToBase64Url(cardHashBytes),
    matrix_user_id: matrixUserId,
    room_id: roomId,
    server_name: serverName,
    protocol_version: PROTOCOL_VERSION_0_1,
    timestamp: now(),
  };
  const signature = mlDsa44Sign(cardSecretKey, canonicalize(payload));

  return {
    payload,
    signatures: [
      {
        public_key: bytesToBase64Url(publicKey),
        signature: bytesToBase64Url(signature),
      },
    ],
  };
}
