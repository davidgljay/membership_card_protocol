/**
 * Platform-agnostic Megolm/Olm crypto-provider interface (Matrix Phase 5,
 * Step 18 — see `plans/milestones/matrix-crypto-binding-decision.md` for the
 * binding decision this interface sits on top of).
 *
 * Follows this package's established `providers/` split
 * (`SecureKeyProvider`, `StorageProvider`, `RealtimeTransportProvider`,
 * ...): the interface lives here, in the shared `client-sdk` package, and
 * says nothing about *how* Olm/Megolm state is actually kept or which
 * binding backs it. Concrete implementations live in the per-platform
 * packages:
 *   - `client-sdk-web`'s `WasmMegolmCryptoProvider` wraps
 *     `@matrix-org/matrix-sdk-crypto-wasm`'s `OlmMachine` (the official Rust
 *     `matrix-sdk-crypto` state machine, compiled to WASM).
 *   - `client-sdk-rn` has no working implementation yet — WASM does not run
 *     on Hermes (see the binding-decision doc), so React Native needs a
 *     custom Turbo Module against the official crypto-only
 *     `matrix-sdk-crypto-ffi` Rust crate via `uniffi-bindgen-react-native`.
 *     `client-sdk-rn/src/MegolmCryptoProvider.ts` is a scaffold/stub only —
 *     see that file's header comment for exactly what's missing.
 *
 * **Why the interface is shaped around "flush outgoing requests" /
 * "receive sync" rather than exposing raw send/decrypt only:** the
 * underlying Matrix crypto state machine (both `matrix-sdk-crypto-wasm`'s
 * `OlmMachine` today, and `matrix-sdk-crypto-ffi`'s equivalent once the RN
 * binding exists) does not perform any network I/O itself — it produces
 * *requests* (`keys/upload`, `keys/query`, `keys/claim`, to-device sends)
 * that the caller must transmit over the Matrix Client-Server API and feed
 * the responses back into the machine, and separately *consumes* to-device
 * events and device-list deltas pulled from `/sync`. A caller cannot
 * establish a Megolm session, or decrypt an event whose room key it hasn't
 * seen yet, without both halves of that loop. Exposing only
 * `encryptRoomEvent`/`decryptRoomEvent` (the shape Step 18's brief starts
 * from) would leave callers with no way to actually drive that loop, so
 * this interface adds the two operations that do: {@link
 * MegolmCryptoProvider.flushOutgoingRequests} (push queued requests out,
 * feed responses back in) and {@link MegolmCryptoProvider.receiveSync}
 * (ingest a `/sync` response's crypto-relevant slice). Both are
 * intentionally still transport-agnostic at this layer — *how* a request
 * gets to the homeserver (which base URL, which access token, which
 * `fetch`) is a construction-time concern of the concrete implementation,
 * the same way `SecureKeyProvider`'s concrete implementations decide their
 * own storage/keychain details without the interface knowing about them.
 */

/** A minimal to-device event, as delivered inside a `/sync` response's `to_device.events` array. */
export interface MatrixToDeviceEventLike {
  type: string;
  sender: string;
  content: Record<string, unknown>;
}

/**
 * A minimal Matrix room timeline event, as delivered inside a `/sync`
 * response's (or `/messages`/`/context`) `content`+envelope shape — the
 * input to {@link MegolmCryptoProvider.decryptRoomEvent}.
 */
export interface MatrixTimelineEventLike {
  type: string;
  sender: string;
  event_id: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
  /** Present on state events only. */
  state_key?: string;
}

/** The crypto-relevant slice of a `/sync` response, ingested by {@link MegolmCryptoProvider.receiveSync}. */
export interface MatrixSyncCryptoInput {
  /** `to_device.events` from the sync response. */
  toDeviceEvents: MatrixToDeviceEventLike[];
  /** `device_lists.changed` — user IDs whose device lists may have changed. */
  changedDeviceUserIds: string[];
  /** `device_lists.left` — user IDs no longer sharing an encrypted room with us. */
  leftDeviceUserIds: string[];
  /** `device_one_time_keys_count`. */
  oneTimeKeyCounts: Record<string, number>;
}

export interface DecryptedMatrixEvent {
  eventType: string;
  sender: string;
  content: Record<string, unknown>;
}

export interface MegolmCryptoProvider {
  /**
   * Push every request the crypto state machine currently has queued
   * (device-key upload, key queries, key claims, to-device sends) out over
   * the homeserver's Client-Server API, and feed each response back in.
   *
   * This is the only method that performs network I/O on the crypto
   * machine's behalf; every other method here either only touches local
   * state or (for {@link ensureRoomSession}) calls this internally as
   * needed. Callers building their own sync loop should also call this
   * once per cycle, since responding to incoming key-claim/query traffic
   * from other devices can itself queue new outgoing requests.
   */
  flushOutgoingRequests(): Promise<void>;

  /**
   * Ingest the crypto-relevant slice of a `/sync` response. Must be called
   * before {@link decryptRoomEvent} can succeed for a room key this client
   * has not seen before — this is how incoming Megolm room keys (wrapped
   * in Olm-encrypted to-device `m.room_key` events) and Olm session
   * material actually reach the crypto state machine.
   */
  receiveSync(input: MatrixSyncCryptoInput): Promise<void>;

  /**
   * Ensure this client holds a usable outbound Megolm session for
   * `roomId`, shared with every user ID in `memberUserIds` — creating and
   * sharing a new session if none exists yet, establishing any missing
   * 1:1 Olm sessions with member devices along the way via {@link
   * flushOutgoingRequests}. Idempotent: a no-op if a session already
   * exists and membership hasn't changed since it was last shared.
   *
   * Must be called (successfully) before {@link encryptRoomEvent} for a
   * room this client has not already established a session for.
   */
  ensureRoomSession(roomId: string, memberUserIds: string[]): Promise<void>;

  /**
   * Encrypt `content` (the plaintext content of a `m.room.message` or
   * other room event) for `roomId` using the room's current outbound
   * Megolm session, returning the `m.room.encrypted` event content ready
   * to send. Throws if {@link ensureRoomSession} has not been called
   * successfully for this room.
   */
  encryptRoomEvent(
    roomId: string,
    eventType: string,
    content: Record<string, unknown>
  ): Promise<Record<string, unknown>>;

  /**
   * Decrypt an `m.room.encrypted` timeline event received for `roomId`,
   * returning the original event type/sender/content. Throws if the
   * relevant Megolm session has not reached this client yet — see {@link
   * receiveSync}.
   */
  decryptRoomEvent(roomId: string, event: MatrixTimelineEventLike): Promise<DecryptedMatrixEvent>;
}
