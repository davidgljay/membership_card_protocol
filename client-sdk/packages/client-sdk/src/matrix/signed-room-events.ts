import { PROTOCOL_VERSION_0_1 } from '@membership-card-protocol/verifier';
import { canonicalize } from '../crypto/canonicalize.js';
import { mlDsa44GetPublicKey, mlDsa44Sign, mlDsa44Verify } from '../crypto/mldsa.js';
import { keccak256 } from '../crypto/hashes.js';
import { bytesToBase64Url, base64UrlToBytes } from '../util/base64url.js';
import type { EnvelopeSignatureEntry, MessageContentByType, MessageType } from '../messaging/envelope.js';
import { deriveMatrixUserId, verifyMatrixUserIdBinding } from './account-id.js';
import { encryptRoomEvent, decryptRoomEvent } from './session.js';
import type { MatrixTimelineEventLike, MegolmCryptoProvider } from './crypto-provider.js';

/**
 * Card-signed room-message envelope + sender-binding enforcement (Matrix
 * Phase 5, Step 19 — `specs/object_specs/matrix_encryption.md §2` for the
 * envelope shape, `§4` for the sender-binding check this module enforces on
 * receipt).
 *
 * Wraps Step 18's `encryptRoomEvent`/`decryptRoomEvent`
 * (`matrix/session.ts`), which are themselves thin wrappers over the
 * injected {@link MegolmCryptoProvider}. This module does not touch Megolm
 * directly — it only decides *what plaintext* goes in
 * (`sendCardSignedRoomEvent`) and *what checks* run on the way out
 * (`receiveCardSignedRoomEvent`).
 *
 * **Envelope shape** (`matrix_encryption.md §2`): the same `payload`/
 * `signatures` shape as `messaging/envelope.ts`'s `CardMessageEnvelope`,
 * minus `recipients`/`senders` (Matrix's own room membership and the
 * event's `sender` field replace those — see §2's "What changes" list),
 * plus an optional `matrix_event_id` cross-reference field. Deliberately a
 * distinct type from `MessagePayload`/`CardMessageEnvelope` rather than a
 * reuse-with-optional-fields hack, since `recipients`/`senders` are
 * structurally absent here, not merely empty.
 *
 * Signing reuses the exact primitives `messaging/envelope.ts` and
 * `matrix/attestation.ts` already use for every other signed object in this
 * SDK: `canonicalize()` (RFC 8785 JCS) and `mlDsa44Sign`/`mlDsa44Verify` —
 * no new signing or verification logic is introduced here.
 */

export interface RoomMessagePayload<T extends MessageType = MessageType> {
  type: T;
  content: MessageContentByType[T];
  protocol_version: string;
  timestamp: string;
  /** Cross-reference to the Matrix event ID carrying this payload, once known — `matrix_encryption.md §2`. */
  matrix_event_id?: string;
  edit_of?: string;
  retracts?: string;
  forwards?: string;
  in_reply_to?: string;
}

export interface RoomMessageEnvelope<T extends MessageType = MessageType> {
  payload: RoomMessagePayload<T>;
  signatures: EnvelopeSignatureEntry[];
}

export interface SendCardSignedRoomEventOptions<T extends MessageType> {
  type: T;
  content: MessageContentByType[T];
  /** Defaults to now. */
  timestamp?: string;
  matrixEventId?: string;
  editOf?: string;
  retracts?: string;
  forwards?: string;
  inReplyTo?: string;
}

/**
 * Thrown by {@link sendCardSignedRoomEvent} when the supplied signing card
 * does not belong to the active room session's own Matrix user ID —
 * enforced at the API boundary, **before** any signing, encryption, or
 * network call is attempted (per the Phase 5 plan's hard constraint: the
 * SDK must only ever sign with the card whose shadow-account Matrix session
 * is actually posting).
 */
export class SigningCardSessionMismatchError extends Error {
  constructor(
    public readonly derivedMatrixUserId: string,
    public readonly activeSessionMatrixUserId: string
  ) {
    super(
      `sendCardSignedRoomEvent: refusing to sign — the signing card derives Matrix user ID ` +
        `${derivedMatrixUserId}, which does not match the active session's own Matrix user ID ` +
        `${activeSessionMatrixUserId}. The SDK only ever signs with the card whose shadow-account ` +
        `session is actually posting (matrix_encryption.md §3/§4).`
    );
    this.name = 'SigningCardSessionMismatchError';
  }
}

/**
 * Thrown by {@link receiveCardSignedRoomEvent} when the embedded ML-DSA-44
 * signature does not verify against the embedded public key over the
 * canonical payload. An ordinary integrity/formatting failure (corrupted
 * ciphertext, a bug, a non-card sender) — distinct from
 * {@link SenderBindingMismatchError}, which describes a *valid* signature
 * from the *wrong* card (`matrix_encryption.md §4`).
 */
export class InvalidSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSignatureError';
  }
}

/**
 * Thrown by {@link receiveCardSignedRoomEvent} when check 1 (signature
 * validity) passes but check 2 (sender-binding, `matrix_encryption.md §4`)
 * fails: the embedded signature is valid, but the card that produced it
 * does not derive the Matrix event's actual `sender`. Per the spec, this is
 * evidence of an attempted identity-drift attack, not a formatting error —
 * kept as a distinct error type/name from {@link InvalidSignatureError} so
 * a caller or auditor can tell the two apart rather than collapsing both
 * into one generic rejection.
 */
export class SenderBindingMismatchError extends Error {
  constructor(
    public readonly signerCardHash: string,
    public readonly matrixSender: string,
    public readonly eventId: string,
    public readonly roomId: string
  ) {
    super(
      `receiveCardSignedRoomEvent: sender-binding check failed for event ${eventId} in room ${roomId} — ` +
        `the embedded signature is VALID but was produced by card_hash ${signerCardHash}, which does not ` +
        `derive Matrix sender ${matrixSender}. This is a valid signature attached to the wrong identity ` +
        `(possible identity-drift attack, matrix_encryption.md §4) — not a formatting error.`
    );
    this.name = 'SenderBindingMismatchError';
  }
}

/**
 * Builds and signs the `matrix_encryption.md §2` card-signature envelope
 * for `message`, then hands the envelope to Step 18's `encryptRoomEvent` as
 * the Megolm plaintext, returning the resulting `m.room.encrypted` event
 * content ready to send over `/send`.
 *
 * **Hard constraint (enforced before anything else runs):** `signingCard`
 * must be the exact card whose shadow-account Matrix session
 * (`activeSessionMatrixUserId`, the access token actually being used to
 * post) belongs to — i.e. `deriveMatrixUserId(keccak256(signingCard's
 * public key), serverName)` must equal `activeSessionMatrixUserId`. If it
 * doesn't, this throws {@link SigningCardSessionMismatchError}
 * synchronously before any signing, encryption, or network call is
 * attempted.
 *
 * @param cryptoProvider - Injected Megolm crypto provider (same instance
 *   used to establish the room's session, e.g. via `joinRoomWithAttestation`).
 * @param roomId - Matrix room ID to post into. Caller must have already
 *   established an outbound Megolm session for this room.
 * @param eventType - The underlying Matrix event type (e.g.
 *   `m.room.message`) — passed straight through to `encryptRoomEvent`.
 * @param message - The room-message payload fields to sign and send.
 * @param signingCardSecretKey - The signing card's ML-DSA-44 secret key.
 * @param activeSessionMatrixUserId - The Matrix user ID of the room
 *   session's own shadow account (the access token being used to post).
 * @param serverName - Homeserver domain, used to derive the signing card's
 *   Matrix user ID for the session-binding check.
 */
export async function sendCardSignedRoomEvent<T extends MessageType>(
  cryptoProvider: MegolmCryptoProvider,
  roomId: string,
  eventType: string,
  message: SendCardSignedRoomEventOptions<T>,
  signingCardSecretKey: Uint8Array,
  activeSessionMatrixUserId: string,
  serverName: string
): Promise<Record<string, unknown>> {
  const publicKey = mlDsa44GetPublicKey(signingCardSecretKey);
  const cardHashHex = keccak256(publicKey);
  const derivedMatrixUserId = deriveMatrixUserId('0x' + cardHashHex, serverName);

  if (derivedMatrixUserId !== activeSessionMatrixUserId) {
    throw new SigningCardSessionMismatchError(derivedMatrixUserId, activeSessionMatrixUserId);
  }

  const exclusiveFieldsSet = [message.editOf, message.retracts, message.forwards].filter(
    (v) => v !== undefined
  ).length;
  if (exclusiveFieldsSet > 1) {
    throw new Error(
      'sendCardSignedRoomEvent: edit_of, retracts, and forwards are mutually exclusive; at most one may be set.'
    );
  }

  const payload: RoomMessagePayload<T> = {
    type: message.type,
    content: message.content,
    protocol_version: PROTOCOL_VERSION_0_1,
    timestamp: message.timestamp ?? new Date().toISOString(),
    ...(message.matrixEventId !== undefined ? { matrix_event_id: message.matrixEventId } : {}),
    ...(message.editOf !== undefined ? { edit_of: message.editOf } : {}),
    ...(message.retracts !== undefined ? { retracts: message.retracts } : {}),
    ...(message.forwards !== undefined ? { forwards: message.forwards } : {}),
    ...(message.inReplyTo !== undefined ? { in_reply_to: message.inReplyTo } : {}),
  };

  const canonicalPayload = canonicalize(payload);
  const signature = mlDsa44Sign(signingCardSecretKey, canonicalPayload);

  const envelope: RoomMessageEnvelope<T> = {
    payload,
    signatures: [
      {
        public_key: bytesToBase64Url(publicKey),
        signature: bytesToBase64Url(signature),
      },
    ],
  };

  return encryptRoomEvent(cryptoProvider, roomId, eventType, envelope as unknown as Record<string, unknown>);
}

export interface ReceiveCardSignedRoomEventResult<T extends MessageType = MessageType> {
  verified: true;
  payload: RoomMessagePayload<T>;
  /** `keccak256(embedded public key)`, hex, `0x`-prefixed — the card that produced the verified signature. */
  signerCardHash: string;
}

/**
 * Decrypts `event` (via Step 18's `decryptRoomEvent`) and runs the two
 * `matrix_encryption.md §4` sender-binding checks, in order, before ever
 * surfacing the payload to the caller:
 *
 * 1. **Signature validity** — `mlDsa44Verify` against the embedded public
 *    key, over the canonical payload. Failure throws
 *    {@link InvalidSignatureError}.
 * 2. **Sender-binding** — `verifyMatrixUserIdBinding(signer_card_hash,
 *    event.sender, server_name)`, where `signer_card_hash` is recovered
 *    from the signature just verified in check 1 (never trusted from any
 *    other field), and `event.sender` is the raw Matrix event's own
 *    `sender` field (the parameter passed in here — not the payload's own
 *    claim, and not re-derived from the crypto provider's decryption
 *    result). Failure throws {@link SenderBindingMismatchError}, kept
 *    distinct from `InvalidSignatureError` since it signals a valid
 *    signature from the *wrong* card, not a formatting failure.
 *
 * Only on passing both checks is `{ verified: true, payload, signerCardHash }`
 * returned.
 */
export async function receiveCardSignedRoomEvent<T extends MessageType = MessageType>(
  cryptoProvider: MegolmCryptoProvider,
  roomId: string,
  event: MatrixTimelineEventLike,
  serverName: string
): Promise<ReceiveCardSignedRoomEventResult<T>> {
  const decrypted = await decryptRoomEvent(cryptoProvider, roomId, event);
  const envelope = decrypted.content as unknown as RoomMessageEnvelope<T>;

  if (
    !envelope ||
    typeof envelope !== 'object' ||
    !envelope.payload ||
    !Array.isArray(envelope.signatures) ||
    envelope.signatures.length === 0 ||
    !envelope.signatures[0]?.public_key ||
    !envelope.signatures[0]?.signature
  ) {
    throw new InvalidSignatureError(
      `receiveCardSignedRoomEvent: decrypted content for event ${event.event_id} in room ${roomId} is not a ` +
        'well-formed card-signature envelope (missing payload or signatures[0]).'
    );
  }

  const [{ public_key: publicKeyB64, signature: signatureB64 }] = envelope.signatures;
  const publicKey = base64UrlToBytes(publicKeyB64);
  const signature = base64UrlToBytes(signatureB64);
  const canonicalPayload = canonicalize(envelope.payload);

  // Check 1 — signature validity.
  if (!mlDsa44Verify(publicKey, canonicalPayload, signature)) {
    throw new InvalidSignatureError(
      `receiveCardSignedRoomEvent: ML-DSA-44 signature verification failed for event ${event.event_id} in room ${roomId}.`
    );
  }

  const signerCardHash = '0x' + keccak256(publicKey);

  // Check 2 — sender-binding (forward verification against the Matrix
  // event's own sender field, per matrix_encryption.md §4).
  if (!verifyMatrixUserIdBinding(signerCardHash, event.sender, serverName)) {
    throw new SenderBindingMismatchError(signerCardHash, event.sender, event.event_id, roomId);
  }

  return { verified: true, payload: envelope.payload, signerCardHash };
}
