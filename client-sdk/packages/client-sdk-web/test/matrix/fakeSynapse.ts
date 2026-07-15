/**
 * A minimal in-memory fake homeserver, used only to give
 * `WasmMegolmCryptoProvider`'s `flushOutgoingRequests`/`ensureRoomSession`
 * something to talk to over HTTP in tests, since there's no live Synapse
 * instance available in this sandbox.
 *
 * **What this fakes and what it doesn't:** this relay implements just
 * enough of `/keys/upload`, `/keys/query`, `/keys/claim`, and
 * `/sendToDevice/{eventType}/{txnId}` to route real `OlmMachine`-produced
 * request bodies between two (or more) `WasmMegolmCryptoProvider`
 * instances sharing one `fetchImpl`. It does not validate tokens beyond a
 * fixed token->user map the test supplies, does not implement auth,
 * ratelimiting, or any other homeserver behavior, and is not a substitute
 * for testing against real Synapse — see this package's test file's own
 * header comment for what that limitation means for this step's test
 * coverage. Crucially, it never touches Olm/Megolm cryptography itself:
 * every byte it stores and relays is exactly what the real `OlmMachine`
 * instances produced and expect back, unexamined and unmodified past JSON
 * parsing.
 */

export interface FakeToDeviceEvent {
  type: string;
  sender: string;
  content: Record<string, unknown>;
}

export interface FakeSynapse {
  fetchImpl: typeof fetch;
  /** Pops (removing them) every to-device event currently queued for `userId`'s `deviceId`. */
  drainToDevice(userId: string, deviceId: string): FakeToDeviceEvent[];
}

/**
 * @param tokenToUserId - Maps a fixed bearer token to the Matrix user ID
 *   it authenticates as, standing in for Synapse's real access-token
 *   lookup.
 */
export function createFakeSynapse(tokenToUserId: Record<string, string>): FakeSynapse {
  /** userId -> deviceId -> raw device_keys object as uploaded. */
  const deviceKeysByUser = new Map<string, Map<string, Record<string, unknown>>>();
  /** userId -> deviceId -> keyId -> raw one-time-key object as uploaded (removed once claimed). */
  const otksByUser = new Map<string, Map<string, Map<string, Record<string, unknown>>>>();
  /** `${userId}:${deviceId}` -> queued to-device events awaiting delivery. */
  const toDeviceInbox = new Map<string, FakeToDeviceEvent[]>();

  function senderFor(init: RequestInit | undefined): string {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const authHeader = headers.Authorization ?? headers.authorization ?? '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const userId = tokenToUserId[token];
    if (!userId) {
      throw new Error(`fakeSynapse: no user registered for bearer token "${token}"`);
    }
    return userId;
  }

  function parseBody(init: RequestInit | undefined): Record<string, unknown> {
    if (!init?.body) return {};
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  }

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    const senderUserId = senderFor(init);
    const body = parseBody(init);

    if (path === '/_matrix/client/v3/keys/upload' && method === 'POST') {
      const deviceKeys = body.device_keys as Record<string, unknown> | undefined;
      const oneTimeKeys = (body.one_time_keys ?? {}) as Record<string, Record<string, unknown>>;
      if (deviceKeys) {
        const deviceId = deviceKeys.device_id as string;
        const userDevices = deviceKeysByUser.get(senderUserId) ?? new Map();
        userDevices.set(deviceId, deviceKeys);
        deviceKeysByUser.set(senderUserId, userDevices);

        const userOtks = otksByUser.get(senderUserId) ?? new Map();
        const deviceOtks = userOtks.get(deviceId) ?? new Map();
        for (const [keyId, keyObj] of Object.entries(oneTimeKeys)) {
          deviceOtks.set(keyId, keyObj);
        }
        userOtks.set(deviceId, deviceOtks);
        otksByUser.set(senderUserId, userOtks);

        return jsonResponse({ one_time_key_counts: { signed_curve25519: deviceOtks.size } });
      }
      return jsonResponse({ one_time_key_counts: {} });
    }

    if (path === '/_matrix/client/v3/keys/query' && method === 'POST') {
      const requestedUsers = Object.keys((body.device_keys ?? {}) as Record<string, unknown>);
      const deviceKeysResponse: Record<string, Record<string, unknown>> = {};
      for (const userId of requestedUsers) {
        const userDevices = deviceKeysByUser.get(userId);
        if (!userDevices) continue;
        deviceKeysResponse[userId] = Object.fromEntries(userDevices.entries());
      }
      return jsonResponse({ device_keys: deviceKeysResponse });
    }

    if (path === '/_matrix/client/v3/keys/claim' && method === 'POST') {
      const requested = (body.one_time_keys ?? {}) as Record<string, Record<string, string>>;
      const claimedResponse: Record<string, Record<string, Record<string, unknown>>> = {};
      for (const [userId, deviceAlgorithms] of Object.entries(requested)) {
        const userOtks = otksByUser.get(userId);
        if (!userOtks) continue;
        for (const deviceId of Object.keys(deviceAlgorithms)) {
          const deviceOtks = userOtks.get(deviceId);
          if (!deviceOtks || deviceOtks.size === 0) continue;
          const [keyId] = deviceOtks.keys();
          const keyObj = deviceOtks.get(keyId)!;
          deviceOtks.delete(keyId); // one-time keys are single-use
          claimedResponse[userId] ??= {};
          claimedResponse[userId][deviceId] = { [keyId]: keyObj };
        }
      }
      return jsonResponse({ one_time_keys: claimedResponse });
    }

    const sendToDeviceMatch = /^\/_matrix\/client\/v3\/sendToDevice\/([^/]+)\/([^/]+)$/.exec(path);
    if (sendToDeviceMatch && method === 'PUT') {
      const eventType = decodeURIComponent(sendToDeviceMatch[1]!);
      const messages = (body.messages ?? {}) as Record<string, Record<string, Record<string, unknown>>>;
      for (const [targetUserId, byDevice] of Object.entries(messages)) {
        for (const [targetDeviceId, content] of Object.entries(byDevice)) {
          const key = `${targetUserId}:${targetDeviceId}`;
          const queue = toDeviceInbox.get(key) ?? [];
          queue.push({ type: eventType, sender: senderUserId, content });
          toDeviceInbox.set(key, queue);
        }
      }
      return jsonResponse({});
    }

    throw new Error(`fakeSynapse: unhandled request ${method} ${path}`);
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    drainToDevice(userId: string, deviceId: string): FakeToDeviceEvent[] {
      const key = `${userId}:${deviceId}`;
      const queue = toDeviceInbox.get(key) ?? [];
      toDeviceInbox.set(key, []);
      return queue;
    },
  };
}
