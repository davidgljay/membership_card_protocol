import {
  initAsync,
  OlmMachine,
  UserId,
  DeviceId,
  RoomId,
  EncryptionSettings,
  DecryptionSettings,
  CollectStrategy,
  TrustRequirement,
  RequestType,
  DeviceLists,
} from '@matrix-org/matrix-sdk-crypto-wasm';
import type {
  DecryptedMatrixEvent,
  MatrixSyncCryptoInput,
  MatrixTimelineEventLike,
  MegolmCryptoProvider,
} from '@membership-card-protocol/client-sdk';

/**
 * Web `MegolmCryptoProvider` (Matrix Phase 5, Step 18): wraps
 * `@matrix-org/matrix-sdk-crypto-wasm`'s `OlmMachine`, the official Rust
 * `matrix-sdk-crypto` state machine compiled to WASM — see
 * `plans/milestones/matrix-crypto-binding-decision.md` for why this
 * package was chosen over bare `vodozemac` bindings or a hand-rolled
 * scheme. `OlmMachine` itself does no network I/O; every request it
 * queues (`keys/upload`, `keys/query`, `keys/claim`, to-device sends) has
 * to be sent over the Matrix Client-Server API by the caller and the
 * response fed back in via `markRequestAsSent`. This class does that
 * plumbing (`#flushOutgoingRequests` / `flushOutgoingRequests`), using the
 * `homeserverUrl`/`accessToken`/`fetchImpl` supplied at construction —
 * mirroring `discovery.ts`'s `fetchImpl` injection convention so the exact
 * same class can be driven against a real homeserver or an injected fake
 * one in tests, without ever mocking the crypto machine itself.
 */
export interface WasmMegolmCryptoProviderOptions {
  /** Base URL of the homeserver's Client-Server API, no trailing slash required. */
  homeserverUrl: string;
  /** Matrix access token for this client's shadow account. */
  accessToken: string;
  /** Injectable `fetch`, primarily for testing. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

/** Request-object shapes shared by every `OlmMachine.outgoingRequests()` member this class knows how to send. */
interface HttpShapedRequest {
  id: string | undefined;
  type: RequestType;
  body: string;
}

export class UnsupportedOutgoingRequestTypeError extends Error {
  constructor(type: RequestType) {
    super(
      `WasmMegolmCryptoProvider: outgoingRequests() returned a request type (${RequestType[type] ?? type}) ` +
        'this provider does not send. Only KeysUpload, KeysQuery, KeysClaim, and ToDevice are handled — ' +
        'cross-signing/backup flows (SignatureUpload, KeysBackup) and interactive-verification-originated ' +
        'RoomMessage requests are out of scope for Step 18 and were never triggered by this class, so seeing ' +
        'one here means a caller invoked an OlmMachine method (e.g. bootstrapCrossSigning) this provider does ' +
        'not expose.'
    );
  }
}

export class WasmMegolmCryptoProvider implements MegolmCryptoProvider {
  readonly #machine: OlmMachine;
  readonly #options: WasmMegolmCryptoProviderOptions;
  /** Room IDs for which `ensureRoomSession` has already shared an outbound session with the current member set. */
  readonly #sharedSessions = new Map<string, string /* sorted member list, to detect membership changes */>();

  private constructor(machine: OlmMachine, options: WasmMegolmCryptoProviderOptions) {
    this.#machine = machine;
    this.#options = options;
  }

  /**
   * Loads the WASM module (if not already loaded) and initializes a fresh
   * `OlmMachine` for `userId`/`deviceId`. Each call creates a new,
   * independent in-memory crypto store — there is no persistence across
   * calls/reloads yet (matching the rest of this package's current
   * device-key custody scope; see `SecureKeyProvider.ts` for the pattern
   * this would eventually follow for durable storage).
   */
  static async create(
    userId: string,
    deviceId: string,
    options: WasmMegolmCryptoProviderOptions
  ): Promise<WasmMegolmCryptoProvider> {
    await initAsync();
    const machine = await OlmMachine.initialize(new UserId(userId), new DeviceId(deviceId));
    return new WasmMegolmCryptoProvider(machine, options);
  }

  async flushOutgoingRequests(): Promise<void> {
    const requests = await this.#machine.outgoingRequests();
    for (const request of requests) {
      const shaped = request as unknown as HttpShapedRequest;
      const { path, method } = this.#httpShapeFor(shaped.type, request);
      const fetchImpl = this.#options.fetchImpl ?? fetch;
      const response = await fetchImpl(`${this.#options.homeserverUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.#options.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: shaped.body,
      });
      const responseText = await response.text();
      if (shaped.id === undefined) {
        throw new Error('WasmMegolmCryptoProvider: outgoing request had no id, cannot mark as sent');
      }
      await this.#machine.markRequestAsSent(shaped.id, shaped.type, responseText);
    }
  }

  async receiveSync(input: MatrixSyncCryptoInput): Promise<void> {
    const deviceLists = new DeviceLists(
      input.changedDeviceUserIds.map((id) => new UserId(id)),
      input.leftDeviceUserIds.map((id) => new UserId(id))
    );
    const oneTimeKeyCounts = new Map<string, number>(Object.entries(input.oneTimeKeyCounts));
    const toDeviceEventsJson = JSON.stringify(
      input.toDeviceEvents.map((event) => ({ type: event.type, sender: event.sender, content: event.content }))
    );
    await this.#machine.receiveSyncChanges(toDeviceEventsJson, deviceLists, oneTimeKeyCounts);
  }

  async ensureRoomSession(roomId: string, memberUserIds: string[]): Promise<void> {
    const membershipKey = [...memberUserIds].sort().join(',');
    if (this.#sharedSessions.get(roomId) === membershipKey) {
      return;
    }

    const userIds = memberUserIds.map((id) => new UserId(id));

    // Make sure device lists for every member are up to date, and Olm
    // sessions exist with every one of their devices, before sharing the
    // room key — otherwise `shareRoomKey` has nothing to encrypt the key
    // to for devices we've never queried/claimed a one-time key from.
    const queryRequest = this.#machine.queryKeysForUsers(userIds.map((u) => u.clone()));
    await this.#sendAndMark(queryRequest.id, RequestType.KeysQuery, this.#httpShapeFor(RequestType.KeysQuery, queryRequest));

    const claimRequest = await this.#machine.getMissingSessions(userIds.map((u) => u.clone()));
    if (claimRequest) {
      await this.#sendAndMark(
        claimRequest.id,
        RequestType.KeysClaim,
        this.#httpShapeFor(RequestType.KeysClaim, claimRequest)
      );
    }

    const settings = new EncryptionSettings();
    settings.sharingStrategy = CollectStrategy.allDevices();
    const toDeviceRequests = await this.#machine.shareRoomKey(new RoomId(roomId), userIds, settings);
    for (const request of toDeviceRequests) {
      await this.#sendAndMark(request.id, RequestType.ToDevice, this.#httpShapeFor(RequestType.ToDevice, request));
    }

    this.#sharedSessions.set(roomId, membershipKey);
  }

  async encryptRoomEvent(
    roomId: string,
    eventType: string,
    content: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const encrypted = await this.#machine.encryptRoomEvent(new RoomId(roomId), eventType, JSON.stringify(content));
    return JSON.parse(encrypted) as Record<string, unknown>;
  }

  async decryptRoomEvent(roomId: string, event: MatrixTimelineEventLike): Promise<DecryptedMatrixEvent> {
    const decryptionSettings = new DecryptionSettings(TrustRequirement.Untrusted);
    const decrypted = await this.#machine.decryptRoomEvent(JSON.stringify(event), new RoomId(roomId), decryptionSettings);
    const parsed = JSON.parse(decrypted.event) as { type: string; sender?: string; content: Record<string, unknown> };
    return {
      eventType: parsed.type,
      sender: parsed.sender ?? decrypted.sender.toString(),
      content: parsed.content,
    };
  }

  /**
   * Sends a single already-shaped request and marks it sent —
   * `ensureRoomSession` needs its query/claim/share sequence applied in
   * that specific order (each step's response can matter to the next), so
   * it drives requests one at a time through this helper rather than the
   * unordered `flushOutgoingRequests` drain loop.
   */
  async #sendAndMark(id: string, type: RequestType, shape: { path: string; method: string; body: string }): Promise<void> {
    const fetchImpl = this.#options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${this.#options.homeserverUrl.replace(/\/+$/, '')}${shape.path}`, {
      method: shape.method,
      headers: {
        Authorization: `Bearer ${this.#options.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: shape.body,
    });
    const responseText = await response.text();
    await this.#machine.markRequestAsSent(id, type, responseText);
  }

  /**
   * Maps an `OlmMachine` outgoing-request object to the Matrix
   * Client-Server API HTTP call it corresponds to. See
   * `UnsupportedOutgoingRequestTypeError` for which request types are
   * deliberately not handled.
   */
  #httpShapeFor(type: RequestType, request: unknown): { path: string; method: string; body: string } {
    switch (type) {
      case RequestType.KeysUpload:
        return { path: '/_matrix/client/v3/keys/upload', method: 'POST', body: (request as { body: string }).body };
      case RequestType.KeysQuery:
        return { path: '/_matrix/client/v3/keys/query', method: 'POST', body: (request as { body: string }).body };
      case RequestType.KeysClaim:
        return { path: '/_matrix/client/v3/keys/claim', method: 'POST', body: (request as { body: string }).body };
      case RequestType.ToDevice: {
        const toDevice = request as { event_type: string; txn_id: string; body: string };
        return {
          path: `/_matrix/client/v3/sendToDevice/${encodeURIComponent(toDevice.event_type)}/${encodeURIComponent(toDevice.txn_id)}`,
          method: 'PUT',
          body: toDevice.body,
        };
      }
      default:
        throw new UnsupportedOutgoingRequestTypeError(type);
    }
  }
}
