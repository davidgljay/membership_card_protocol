import { describe, it, expect } from 'vitest';
import {
  sendCardSignedRoomEvent,
  receiveCardSignedRoomEvent,
  SigningCardSessionMismatchError,
  InvalidSignatureError,
  SenderBindingMismatchError,
  deriveMatrixUserId,
  mlDsa44GenerateKeypair,
  keccak256,
  type MatrixTimelineEventLike,
} from '@membership-card-protocol/client-sdk';
import { WasmMegolmCryptoProvider } from '../../src/MegolmCryptoProvider.js';
import { createFakeSynapse } from './fakeSynapse.js';

/**
 * Step 19 — `sendCardSignedRoomEvent`/`receiveCardSignedRoomEvent`
 * (`client-sdk/src/matrix/signed-room-events.ts`), exercised against the
 * real `@matrix-org/matrix-sdk-crypto-wasm` `OlmMachine` via
 * `WasmMegolmCryptoProvider` (Step 18) — same real-crypto, fake-transport
 * pattern as `MegolmCryptoProvider.test.ts`: nothing about the ML-DSA-44
 * signing/verification or the Megolm encrypt/decrypt path is mocked, only
 * the homeserver HTTP transport (`./fakeSynapse.ts`) is faked, since there
 * is no live Synapse instance available in this sandbox.
 *
 * Card A/B's Matrix user IDs are computed via the real
 * `deriveMatrixUserId` (Phase 5 shadow-account derivation,
 * `matrix_encryption.md §3`) from each card's own ML-DSA-44 keypair — the
 * `OlmMachine` instances standing in for "Alice's device"/"Bob's device"
 * are created under those exact derived IDs, so the crypto-binding
 * constraint under test (signing card must match the active session's own
 * Matrix user ID) is checked against a real derivation, not a fixture
 * string chosen to make the test pass.
 */
describe('sendCardSignedRoomEvent / receiveCardSignedRoomEvent (real ML-DSA-44 + real Megolm)', () => {
  const SERVER_NAME = 'example.org';
  const HOMESERVER_URL = 'https://synapse.example.org';
  const ROOM_ID = '!card-gated-room:example.org';

  const cardA = mlDsa44GenerateKeypair(); // "Alice"
  const cardB = mlDsa44GenerateKeypair(); // "Bob"
  const cardAHash = '0x' + keccak256(cardA.publicKey);
  const cardBHash = '0x' + keccak256(cardB.publicKey);
  const ALICE_MATRIX_ID = deriveMatrixUserId(cardAHash, SERVER_NAME);
  const BOB_MATRIX_ID = deriveMatrixUserId(cardBHash, SERVER_NAME);
  const ALICE_DEVICE = 'ALICEDEVICE';
  const BOB_DEVICE = 'BOBDEVICE';
  const ALICE_TOKEN = 'alice-access-token';
  const BOB_TOKEN = 'bob-access-token';

  async function setUpTwoParties() {
    const synapse = createFakeSynapse({ [ALICE_TOKEN]: ALICE_MATRIX_ID, [BOB_TOKEN]: BOB_MATRIX_ID });
    const alice = await WasmMegolmCryptoProvider.create(ALICE_MATRIX_ID, ALICE_DEVICE, {
      homeserverUrl: HOMESERVER_URL,
      accessToken: ALICE_TOKEN,
      fetchImpl: synapse.fetchImpl,
    });
    const bob = await WasmMegolmCryptoProvider.create(BOB_MATRIX_ID, BOB_DEVICE, {
      homeserverUrl: HOMESERVER_URL,
      accessToken: BOB_TOKEN,
      fetchImpl: synapse.fetchImpl,
    });
    await alice.flushOutgoingRequests();
    await bob.flushOutgoingRequests();

    // Alice establishes her outbound session and shares it with Bob.
    await alice.ensureRoomSession(ROOM_ID, [ALICE_MATRIX_ID, BOB_MATRIX_ID]);
    const bobInbox = synapse.drainToDevice(BOB_MATRIX_ID, BOB_DEVICE);
    await bob.receiveSync({ toDeviceEvents: bobInbox, changedDeviceUserIds: [], leftDeviceUserIds: [], oneTimeKeyCounts: {} });

    // Bob establishes his own outbound session and shares it with Alice, so
    // both directions are usable (needed by tests that have Bob post, e.g.
    // the sender-binding worked example and the corrupted-signature test).
    await bob.ensureRoomSession(ROOM_ID, [ALICE_MATRIX_ID, BOB_MATRIX_ID]);
    const aliceInbox = synapse.drainToDevice(ALICE_MATRIX_ID, ALICE_DEVICE);
    await alice.receiveSync({ toDeviceEvents: aliceInbox, changedDeviceUserIds: [], leftDeviceUserIds: [], oneTimeKeyCounts: {} });

    return { synapse, alice, bob };
  }

  it('1. end-to-end round trip: a message posted by card A and read by card B is content-correct AND card-verified', async () => {
    const { alice, bob } = await setUpTwoParties();

    const encrypted = await sendCardSignedRoomEvent(
      alice,
      ROOM_ID,
      'm.room.message',
      { type: 'text', content: { body: 'meeting moved to 3pm', format: 'plain' } },
      cardA.secretKey,
      ALICE_MATRIX_ID,
      SERVER_NAME
    );

    const event: MatrixTimelineEventLike = {
      type: 'm.room.encrypted',
      sender: ALICE_MATRIX_ID,
      event_id: '$event-1',
      origin_server_ts: Date.now(),
      content: encrypted,
    };

    const result = await receiveCardSignedRoomEvent(bob, ROOM_ID, event, SERVER_NAME);

    expect(result.verified).toBe(true);
    expect(result.payload.type).toBe('text');
    expect(result.payload.content).toEqual({ body: 'meeting moved to 3pm', format: 'plain' });
    expect(result.signerCardHash).toBe(cardAHash);
  });

  it('2. a tampered ciphertext is rejected by Megolm AEAD (at the crypto-provider layer)', async () => {
    const { alice, bob } = await setUpTwoParties();

    const encrypted = await sendCardSignedRoomEvent(
      alice,
      ROOM_ID,
      'm.room.message',
      { type: 'text', content: { body: 'untampered', format: 'plain' } },
      cardA.secretKey,
      ALICE_MATRIX_ID,
      SERVER_NAME
    );

    const tampered = { ...encrypted, ciphertext: (encrypted.ciphertext as string).slice(0, -4) + 'AAAA' };
    const event: MatrixTimelineEventLike = {
      type: 'm.room.encrypted',
      sender: ALICE_MATRIX_ID,
      event_id: '$event-2',
      origin_server_ts: Date.now(),
      content: tampered,
    };

    await expect(receiveCardSignedRoomEvent(bob, ROOM_ID, event, SERVER_NAME)).rejects.toThrow();
  });

  it('3. a signature that does not verify is rejected as InvalidSignatureError', async () => {
    const { alice, bob } = await setUpTwoParties();

    const encrypted = await sendCardSignedRoomEvent(
      alice,
      ROOM_ID,
      'm.room.message',
      { type: 'text', content: { body: 'hello', format: 'plain' } },
      cardA.secretKey,
      ALICE_MATRIX_ID,
      SERVER_NAME
    );

    // Decrypt (via Bob's already-established session with Alice) to get at
    // the plaintext envelope, corrupt the signature, then re-encrypt over
    // Bob's own real outbound session (established in setUpTwoParties) and
    // have Alice decrypt+verify it — isolating check 1 (signature validity)
    // from Megolm's own AEAD, which test 2 already covers separately.
    const decryptedForCorruption = await bob.decryptRoomEvent(ROOM_ID, {
      type: 'm.room.encrypted',
      sender: ALICE_MATRIX_ID,
      event_id: '$event-3-precheck',
      origin_server_ts: Date.now(),
      content: encrypted,
    });
    const envelope = decryptedForCorruption.content as { payload: unknown; signatures: { public_key: string; signature: string }[] };
    const corruptedSignature = envelope.signatures[0]!.signature.slice(0, -4) + 'XXXX';
    const corruptedEnvelope = {
      payload: envelope.payload,
      signatures: [{ public_key: envelope.signatures[0]!.public_key, signature: corruptedSignature }],
    };

    const reEncrypted = await bob.encryptRoomEvent(ROOM_ID, 'm.room.message', corruptedEnvelope);

    const event: MatrixTimelineEventLike = {
      type: 'm.room.encrypted',
      sender: BOB_MATRIX_ID,
      event_id: '$event-3',
      origin_server_ts: Date.now(),
      content: reEncrypted,
    };

    await expect(receiveCardSignedRoomEvent(alice, ROOM_ID, event, SERVER_NAME)).rejects.toThrow(InvalidSignatureError);
  });

  it('4. the worked-example attack: a VALID signature from a different card than the Matrix sender implies is rejected as sender_binding_mismatch', async () => {
    const { alice, bob } = await setUpTwoParties();

    // Card B signs and sends a message over Bob's own real session/account —
    // a perfectly legitimate message from Bob.
    const encryptedFromBob = await sendCardSignedRoomEvent(
      bob,
      ROOM_ID,
      'm.room.message',
      { type: 'text', content: { body: 'hi, this is genuinely bob', format: 'plain' } },
      cardB.secretKey,
      BOB_MATRIX_ID,
      SERVER_NAME
    );

    // The attack: a compromised client controlling Alice's Matrix session
    // relays that same, validly-signed-by-card-B ciphertext but claims it
    // as Alice's own event (forges the outer Matrix event's `sender` field
    // to Alice's shadow account, while the embedded envelope is still
    // signed by card B's real, valid signature).
    const forgedEvent: MatrixTimelineEventLike = {
      type: 'm.room.encrypted',
      sender: ALICE_MATRIX_ID, // forged: claims to be card A / Alice
      event_id: '$event-4',
      origin_server_ts: Date.now(),
      content: encryptedFromBob, // but the ciphertext is really Bob's (card B's) message
    };

    // Alice's own device can decrypt Bob's real Megolm session content (she
    // is a room member and received the session in setUpTwoParties), so
    // decryption succeeds and check 1 (signature validity) passes — the
    // signature really is valid, just for card B, not card A.
    let caught: unknown;
    try {
      await receiveCardSignedRoomEvent(alice, ROOM_ID, forgedEvent, SERVER_NAME);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SenderBindingMismatchError);
    expect(caught).not.toBeInstanceOf(InvalidSignatureError);
    const mismatch = caught as SenderBindingMismatchError;
    expect(mismatch.signerCardHash).toBe(cardBHash);
    expect(mismatch.matrixSender).toBe(ALICE_MATRIX_ID);
  });

  it('5. refuses to sign with a card that does not match the active session Matrix user ID, before any encryption/network call', async () => {
    const { alice } = await setUpTwoParties();

    let caught: unknown;
    try {
      // Card B's secret key, but claiming Alice's (card A's) active session.
      await sendCardSignedRoomEvent(
        alice,
        ROOM_ID,
        'm.room.message',
        { type: 'text', content: { body: 'should never be sent', format: 'plain' } },
        cardB.secretKey,
        ALICE_MATRIX_ID,
        SERVER_NAME
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SigningCardSessionMismatchError);
  });
});
