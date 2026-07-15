/**
 * Room-join + Megolm session wiring (Matrix Phase 5, Step 18).
 *
 * Joins a Matrix room via the Client-Server `/join` API, using a Matrix
 * access token minted by `wallet-service`'s `POST /matrix/token`
 * (`plans/matrix-implementation-plan.md` Step 15c — this module accepts the
 * token as a parameter and never calls that endpoint itself), and attaches
 * the Step 17a join attestation
 * (`matrix/attestation.ts`'s `buildJoinAttestation`) to the join.
 *
 * **Attestation wire transport**, per
 * `specs/process_specs/matrix_join_attestation_and_revocation.md §"Wire
 * transport — resolved 2026-07-12"`: Synapse's `user_may_join_room`
 * callback has no parameter carrying arbitrary request content, so a
 * custom `/join` *query* parameter can never reach the server-side check —
 * the attestation instead rides as an additional top-level key
 * (`io.cardprotocol.join_attestation`) in the `/join` request body, which
 * Synapse merges into the resulting `m.room.member` join event's own
 * `content` (the same mechanism MSC3083 restricted-room join authorization
 * already relies on — arbitrary additional event-content keys are
 * permitted and ignored by clients that don't understand them). The
 * server-side check then runs inside `check_event_for_spam` when it
 * observes that event, per
 * `wallet-service/matrix-policy-module/src/matrix_policy_module/module.py`'s
 * docstring. This is *not* the request body's `reason` field — `reason` is
 * a distinct, spec-defined string field this module does not use.
 *
 * After a successful join, this module hands off to the injected {@link
 * MegolmCryptoProvider} to establish (if this client is the first member
 * to need one) or receive (if a session already exists and simply hasn't
 * reached this device yet — via {@link MegolmCryptoProvider.receiveSync})
 * the room's Megolm session, so the caller can start
 * encrypting/decrypting immediately after `joinRoomWithAttestation`
 * resolves.
 */

import { buildJoinAttestation, JOIN_ATTESTATION_EVENT_CONTENT_KEY } from './attestation.js';
import type { DecryptedMatrixEvent, MatrixTimelineEventLike, MegolmCryptoProvider } from './crypto-provider.js';

export interface JoinRoomOptions {
  /** Injectable `fetch`, primarily for testing. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable timestamp source for the attestation, primarily for testing. */
  now?: () => string;
}

export interface JoinRoomResult {
  /** The room ID actually joined — normally identical to the requested `roomId`, but Matrix's `/join` API allows joining via a room alias, in which case this is the resolved room ID. */
  roomId: string;
}

/**
 * Joins `roomId` on `homeserverUrl` using `accessToken`, attaching a
 * freshly-built join attestation for `cardSecretKey`, then ensures the
 * room's Megolm session is established/received via `cryptoProvider`.
 *
 * @param cardSecretKey - The joining card's ML-DSA-44 secret key (used to
 *   sign the join attestation — see `attestation.ts`).
 * @param roomId - Matrix room ID (or alias) to join.
 * @param homeserverUrl - Base URL of the homeserver's Client-Server API
 *   (e.g. `https://matrix.example.org`), no trailing slash required.
 * @param accessToken - A Matrix access token for the joining shadow
 *   account, as minted by `wallet-service`'s `POST /matrix/token`.
 * @param serverName - Homeserver domain, used both for the attestation's
 *   `server_name` field and to derive the joining shadow account's own
 *   Matrix user ID (via `attestation.ts` -> `account-id.ts`).
 * @param cryptoProvider - Platform crypto provider used to establish/
 *   receive the room's Megolm session after the join succeeds.
 * @param memberUserIds - The room's current member Matrix user IDs (as
 *   known to the caller, e.g. from room state), passed through to {@link
 *   MegolmCryptoProvider.ensureRoomSession}.
 */
export async function joinRoomWithAttestation(
  cardSecretKey: Uint8Array,
  roomId: string,
  homeserverUrl: string,
  accessToken: string,
  serverName: string,
  cryptoProvider: MegolmCryptoProvider,
  memberUserIds: string[],
  options: JoinRoomOptions = {}
): Promise<JoinRoomResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const attestation = buildJoinAttestation(cardSecretKey, roomId, serverName, options.now);

  const response = await fetchImpl(
    `${homeserverUrl.replace(/\/+$/, '')}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        [JOIN_ATTESTATION_EVENT_CONTENT_KEY]: attestation,
      }),
    }
  );

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '<unreadable body>');
    throw new Error(`joinRoomWithAttestation: /join failed for room ${roomId} (${response.status}): ${bodyText}`);
  }

  const body = (await response.json()) as { room_id?: string };
  const joinedRoomId = body.room_id ?? roomId;

  await cryptoProvider.ensureRoomSession(joinedRoomId, memberUserIds);

  return { roomId: joinedRoomId };
}

/**
 * Thin wrapper over `cryptoProvider.encryptRoomEvent` (kept as a free
 * function, exported from the matrix module, per Step 18's brief) — encrypts
 * `content` for `roomId` using the room's current outbound Megolm session.
 * Callers must have already established that session, e.g. via {@link
 * joinRoomWithAttestation} or a direct `cryptoProvider.ensureRoomSession`
 * call.
 */
export async function encryptRoomEvent(
  cryptoProvider: MegolmCryptoProvider,
  roomId: string,
  eventType: string,
  content: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return cryptoProvider.encryptRoomEvent(roomId, eventType, content);
}

/**
 * Thin wrapper over `cryptoProvider.decryptRoomEvent` — decrypts an
 * `m.room.encrypted` timeline event for `roomId`. Callers must have already
 * fed the relevant Megolm session in via `cryptoProvider.receiveSync`
 * (directly, or indirectly via {@link joinRoomWithAttestation}'s
 * `ensureRoomSession` call) before this can succeed.
 */
export async function decryptRoomEvent(
  cryptoProvider: MegolmCryptoProvider,
  roomId: string,
  event: MatrixTimelineEventLike
): Promise<DecryptedMatrixEvent> {
  return cryptoProvider.decryptRoomEvent(roomId, event);
}
