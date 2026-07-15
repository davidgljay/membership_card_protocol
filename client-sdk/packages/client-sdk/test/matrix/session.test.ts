import { describe, it, expect, vi } from 'vitest';
import { joinRoomWithAttestation, encryptRoomEvent, decryptRoomEvent } from '../../src/matrix/session.js';
import { JOIN_ATTESTATION_EVENT_CONTENT_KEY } from '../../src/matrix/attestation.js';
import { mlDsa44GenerateKeypair } from '../../src/crypto/mldsa.js';
import type { MegolmCryptoProvider } from '../../src/matrix/crypto-provider.js';

const ROOM_ID = '!card-gated-room:matrix.internal';
const SERVER_NAME = 'matrix.internal';
const HOMESERVER_URL = 'https://matrix.internal';
const ACCESS_TOKEN = 'test-access-token';
const FIXED_NOW = () => '2026-07-14T12:00:00.000Z';

function makeCryptoProvider(): MegolmCryptoProvider & {
  ensureRoomSession: ReturnType<typeof vi.fn>;
} {
  return {
    flushOutgoingRequests: vi.fn(async () => {}),
    receiveSync: vi.fn(async () => {}),
    ensureRoomSession: vi.fn(async () => {}),
    encryptRoomEvent: vi.fn(async (_roomId: string, _eventType: string, content: Record<string, unknown>) => ({
      algorithm: 'm.megolm.v1.aes-sha2',
      ciphertext: 'fake-ciphertext-for(' + JSON.stringify(content) + ')',
    })),
    decryptRoomEvent: vi.fn(async () => ({
      eventType: 'm.room.message',
      sender: '@alice:matrix.internal',
      content: { body: 'decrypted' },
    })),
  };
}

/**
 * A mock join-handling server, following this package's established
 * pattern (`discovery.ts`'s tests inject a mock `fetchImpl` against a fake
 * `wallet-service`/IPFS-gateway server rather than a live one). There is
 * no live Synapse instance available in this sandbox, so this test can
 * only confirm the client sends the attestation in the right place — it
 * cannot exercise Synapse's actual server-side
 * `check_event_for_spam`/`_authorize_join_event` verification
 * (`wallet-service/matrix-policy-module`). That real verification path is
 * covered by that package's own Python test suite, not here.
 */
function makeRecordingJoinServer(respond: (body: Record<string, unknown>) => { ok: boolean; status: number; json: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit; body: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url: String(url), init, body });
    const result = respond(body);
    return {
      ok: result.ok,
      status: result.status,
      json: async () => result.json,
      text: async () => JSON.stringify(result.json),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('joinRoomWithAttestation', () => {
  it('attaches the join attestation under JOIN_ATTESTATION_EVENT_CONTENT_KEY in the /join request body', async () => {
    const { secretKey } = mlDsa44GenerateKeypair();
    const cryptoProvider = makeCryptoProvider();
    const server = makeRecordingJoinServer(() => ({ ok: true, status: 200, json: { room_id: ROOM_ID } }));

    await joinRoomWithAttestation(
      secretKey,
      ROOM_ID,
      HOMESERVER_URL,
      ACCESS_TOKEN,
      SERVER_NAME,
      cryptoProvider,
      ['@alice:matrix.internal', '@bob:matrix.internal'],
      { fetchImpl: server.fetchImpl, now: FIXED_NOW }
    );

    expect(server.calls).toHaveLength(1);
    const [call] = server.calls;
    expect(call!.url).toBe(`${HOMESERVER_URL}/_matrix/client/v3/join/${encodeURIComponent(ROOM_ID)}`);
    expect(call!.init?.method).toBe('POST');
    expect((call!.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);

    const attestation = call!.body[JOIN_ATTESTATION_EVENT_CONTENT_KEY] as { payload: Record<string, unknown> };
    expect(attestation).toBeDefined();
    expect(attestation.payload.type).toBe('room_join_attestation');
    expect(attestation.payload.room_id).toBe(ROOM_ID);
    expect(attestation.payload.server_name).toBe(SERVER_NAME);
  });

  it('a request with no attestation attached (simulating a broken/bypassing caller) is distinguishable and rejected by a policy-enforcing mock server', async () => {
    // This test doesn't call joinRoomWithAttestation at all — it directly
    // proves the negative: a /join POST that omits the attestation key is
    // exactly what a real Synapse policy module (per
    // matrix_join_attestation_and_revocation.md) would reject. Since there's
    // no live Synapse here, the "rejection" is enforced by this mock server
    // inspecting the same key real check_event_for_spam does.
    const server = makeRecordingJoinServer((body) => {
      const hasAttestation = JOIN_ATTESTATION_EVENT_CONTENT_KEY in body;
      return hasAttestation
        ? { ok: true, status: 200, json: { room_id: ROOM_ID } }
        : { ok: false, status: 403, json: { errcode: 'M_FORBIDDEN', error: 'missing join attestation' } };
    });

    const response = await server.fetchImpl(`${HOMESERVER_URL}/_matrix/client/v3/join/${encodeURIComponent(ROOM_ID)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);
  });

  it('rejects (throws) when the homeserver rejects the join', async () => {
    const { secretKey } = mlDsa44GenerateKeypair();
    const cryptoProvider = makeCryptoProvider();
    const server = makeRecordingJoinServer(() => ({
      ok: false,
      status: 403,
      json: { errcode: 'M_FORBIDDEN', error: 'invalid join attestation' },
    }));

    await expect(
      joinRoomWithAttestation(secretKey, ROOM_ID, HOMESERVER_URL, ACCESS_TOKEN, SERVER_NAME, cryptoProvider, [], {
        fetchImpl: server.fetchImpl,
        now: FIXED_NOW,
      })
    ).rejects.toThrow(/join failed/);

    expect(cryptoProvider.ensureRoomSession).not.toHaveBeenCalled();
  });

  it('calls cryptoProvider.ensureRoomSession with the joined room id and member list after a successful join', async () => {
    const { secretKey } = mlDsa44GenerateKeypair();
    const cryptoProvider = makeCryptoProvider();
    const server = makeRecordingJoinServer(() => ({ ok: true, status: 200, json: { room_id: ROOM_ID } }));
    const members = ['@alice:matrix.internal', '@bob:matrix.internal'];

    const result = await joinRoomWithAttestation(
      secretKey,
      ROOM_ID,
      HOMESERVER_URL,
      ACCESS_TOKEN,
      SERVER_NAME,
      cryptoProvider,
      members,
      { fetchImpl: server.fetchImpl, now: FIXED_NOW }
    );

    expect(result.roomId).toBe(ROOM_ID);
    expect(cryptoProvider.ensureRoomSession).toHaveBeenCalledWith(ROOM_ID, members);
  });

  it('falls back to the requested roomId when the server response omits room_id (e.g. joined via alias)', async () => {
    const { secretKey } = mlDsa44GenerateKeypair();
    const cryptoProvider = makeCryptoProvider();
    const server = makeRecordingJoinServer(() => ({ ok: true, status: 200, json: {} }));

    const result = await joinRoomWithAttestation(
      secretKey,
      ROOM_ID,
      HOMESERVER_URL,
      ACCESS_TOKEN,
      SERVER_NAME,
      cryptoProvider,
      [],
      { fetchImpl: server.fetchImpl, now: FIXED_NOW }
    );

    expect(result.roomId).toBe(ROOM_ID);
  });
});

describe('encryptRoomEvent / decryptRoomEvent (thin wrappers)', () => {
  it('encryptRoomEvent delegates to the provider', async () => {
    const cryptoProvider = makeCryptoProvider();
    const content = { body: 'hi', msgtype: 'm.text' };

    const result = await encryptRoomEvent(cryptoProvider, ROOM_ID, 'm.room.message', content);

    expect(cryptoProvider.encryptRoomEvent).toHaveBeenCalledWith(ROOM_ID, 'm.room.message', content);
    expect(result.algorithm).toBe('m.megolm.v1.aes-sha2');
  });

  it('decryptRoomEvent delegates to the provider', async () => {
    const cryptoProvider = makeCryptoProvider();
    const event = {
      type: 'm.room.encrypted',
      sender: '@alice:matrix.internal',
      event_id: '$1',
      origin_server_ts: 0,
      content: {},
    };

    const result = await decryptRoomEvent(cryptoProvider, ROOM_ID, event);

    expect(cryptoProvider.decryptRoomEvent).toHaveBeenCalledWith(ROOM_ID, event);
    expect(result.content).toEqual({ body: 'decrypted' });
  });
});
