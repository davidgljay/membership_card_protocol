import { describe, it, expect } from 'vitest';
import { WasmMegolmCryptoProvider } from '../../src/MegolmCryptoProvider.js';
import { createFakeSynapse } from './fakeSynapse.js';

/**
 * Exercises the real `@matrix-org/matrix-sdk-crypto-wasm` `OlmMachine` —
 * per Step 18's brief, this must NOT mock the crypto provider or the
 * underlying `OlmMachine`. Two independent `WasmMegolmCryptoProvider`
 * instances (standing in for two card holders' devices) run the real
 * device-key upload / key-query / key-claim / Megolm-session-share
 * handshake and exchange a real end-to-end-encrypted message in both
 * directions.
 *
 * **What's real vs. faked here:** the WASM binding, the `OlmMachine`
 * state machine, and every cryptographic operation it performs (Olm
 * session establishment via X3DH-style one-time-key claiming, Megolm
 * session creation/sharing, AES-encrypted room-event ciphertext) are the
 * genuine `@matrix-org/matrix-sdk-crypto-wasm` implementation — nothing
 * about the crypto path is mocked. What *is* faked is the homeserver
 * transport itself (`./fakeSynapse.ts`): there is no live Synapse
 * instance in this sandbox, so an in-memory relay stands in for the
 * `/keys/upload`, `/keys/query`, `/keys/claim`, and `/sendToDevice`
 * endpoints, faithfully round-tripping the exact request/response bodies
 * `OlmMachine` itself produces and expects — this is the same
 * injected-`fetchImpl` pattern this package's `discovery.test.ts` already
 * uses for a different endpoint, not a new testing approach. This proves
 * the crypto provider correctly drives `OlmMachine`'s request/response
 * and sync-ingestion contracts end-to-end; it does not prove anything
 * about real-Synapse-specific behavior (auth edge cases, rate limits,
 * actual network conditions) — that remains untested here, same
 * limitation Step 18's brief anticipated.
 */
describe('WasmMegolmCryptoProvider (real matrix-sdk-crypto-wasm OlmMachine)', () => {
  const ALICE = '@alice:example.org';
  const ALICE_DEVICE = 'ALICEDEVICE';
  const BOB = '@bob:example.org';
  const BOB_DEVICE = 'BOBDEVICE';
  const ROOM_ID = '!card-room:example.org';
  const HOMESERVER_URL = 'https://synapse.example.org';
  const ALICE_TOKEN = 'alice-access-token';
  const BOB_TOKEN = 'bob-access-token';

  it('two clients establish a Megolm session and exchange an encrypted message in both directions', async () => {
    const synapse = createFakeSynapse({ [ALICE_TOKEN]: ALICE, [BOB_TOKEN]: BOB });

    const alice = await WasmMegolmCryptoProvider.create(ALICE, ALICE_DEVICE, {
      homeserverUrl: HOMESERVER_URL,
      accessToken: ALICE_TOKEN,
      fetchImpl: synapse.fetchImpl,
    });
    const bob = await WasmMegolmCryptoProvider.create(BOB, BOB_DEVICE, {
      homeserverUrl: HOMESERVER_URL,
      accessToken: BOB_TOKEN,
      fetchImpl: synapse.fetchImpl,
    });

    // Both devices publish their identity/one-time keys before anything else can happen.
    await alice.flushOutgoingRequests();
    await bob.flushOutgoingRequests();

    // --- Alice -> Bob ---
    await alice.ensureRoomSession(ROOM_ID, [ALICE, BOB]);

    const bobInbox = synapse.drainToDevice(BOB, BOB_DEVICE);
    expect(bobInbox.length).toBeGreaterThan(0); // the room key really was sent over the wire
    await bob.receiveSync({
      toDeviceEvents: bobInbox,
      changedDeviceUserIds: [],
      leftDeviceUserIds: [],
      oneTimeKeyCounts: {},
    });

    const plaintextToBob = { msgtype: 'm.text', body: 'hello bob, this is alice' };
    const encryptedForBob = await alice.encryptRoomEvent(ROOM_ID, 'm.room.message', plaintextToBob);
    expect(encryptedForBob.algorithm).toBe('m.megolm.v1.aes-sha2');
    expect(typeof encryptedForBob.ciphertext).toBe('string');

    const decryptedByBob = await bob.decryptRoomEvent(ROOM_ID, {
      type: 'm.room.encrypted',
      sender: ALICE,
      event_id: '$event-1',
      origin_server_ts: Date.now(),
      content: encryptedForBob,
    });
    expect(decryptedByBob.eventType).toBe('m.room.message');
    expect(decryptedByBob.sender).toBe(ALICE);
    expect(decryptedByBob.content).toEqual(plaintextToBob);

    // --- Bob -> Alice, proving this is a real exchange, not one-directional ---
    await bob.ensureRoomSession(ROOM_ID, [ALICE, BOB]);

    const aliceInbox = synapse.drainToDevice(ALICE, ALICE_DEVICE);
    expect(aliceInbox.length).toBeGreaterThan(0);
    await alice.receiveSync({
      toDeviceEvents: aliceInbox,
      changedDeviceUserIds: [],
      leftDeviceUserIds: [],
      oneTimeKeyCounts: {},
    });

    const plaintextToAlice = { msgtype: 'm.text', body: 'hi alice, bob here' };
    const encryptedForAlice = await bob.encryptRoomEvent(ROOM_ID, 'm.room.message', plaintextToAlice);

    const decryptedByAlice = await alice.decryptRoomEvent(ROOM_ID, {
      type: 'm.room.encrypted',
      sender: BOB,
      event_id: '$event-2',
      origin_server_ts: Date.now(),
      content: encryptedForAlice,
    });
    expect(decryptedByAlice.eventType).toBe('m.room.message');
    expect(decryptedByAlice.sender).toBe(BOB);
    expect(decryptedByAlice.content).toEqual(plaintextToAlice);
  });

  it('ensureRoomSession is idempotent for an unchanged membership set', async () => {
    const synapse = createFakeSynapse({ [ALICE_TOKEN]: ALICE, [BOB_TOKEN]: BOB });
    const alice = await WasmMegolmCryptoProvider.create(ALICE, ALICE_DEVICE, {
      homeserverUrl: HOMESERVER_URL,
      accessToken: ALICE_TOKEN,
      fetchImpl: synapse.fetchImpl,
    });
    const bob = await WasmMegolmCryptoProvider.create(BOB, BOB_DEVICE, {
      homeserverUrl: HOMESERVER_URL,
      accessToken: BOB_TOKEN,
      fetchImpl: synapse.fetchImpl,
    });
    await alice.flushOutgoingRequests();
    await bob.flushOutgoingRequests();

    await alice.ensureRoomSession(ROOM_ID, [ALICE, BOB]);
    const firstBatch = synapse.drainToDevice(BOB, BOB_DEVICE);
    expect(firstBatch.length).toBeGreaterThan(0);

    // Calling again with the same membership must not re-share the room key.
    await alice.ensureRoomSession(ROOM_ID, [ALICE, BOB]);
    const secondBatch = synapse.drainToDevice(BOB, BOB_DEVICE);
    expect(secondBatch.length).toBe(0);
  });
});
