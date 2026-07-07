import { describe, it, expect } from 'vitest';
import type { IpfsProvider, RpcProvider } from '@membership-card-protocol/verifier';
import { createCardVerifier } from '../../src/verification/CardVerifier.js';
import { mlDsa44GenerateKeypair, mlDsa44Sign } from '../../src/crypto/mldsa.js';
import { mlKem768GenerateKeypair } from '../../src/crypto/mlkem.js';
import { keccak256 } from '../../src/crypto/hashes.js';
import { buildMessagePayload, signMessageEnvelope } from '../../src/messaging/envelope.js';
import { fanOutMessageToSubCards, type SubCardRecipient } from '../../src/messaging/fanout.js';
import { handleInboundRoutingEnvelope } from '../../src/messaging/inbound.js';
import { registerMultipleCardsUuids, type ObliviousProtocolTransportFactory } from '../../src/messaging/uuidRegistration.js';
import { deregisterCardUuids } from '../../src/messaging/uuidDeregistration.js';
import type { StorageProvider } from '../../src/providers/StorageProvider.js';

/**
 * Phase 5 Milestone Review — "Done when": a two-device (or
 * two-simulated-instance) test confirms independent per-subcard message
 * delivery; session-separation and staggering tests from Step 5.3 pass
 * (verified separately in `test/messaging/uuidRegistration.test.ts`,
 * unaffected by this file).
 *
 * This test simulates ONE holder's card, registered on TWO physical
 * devices (device A and device B), each holding its own sub-card key pair
 * — exactly `notification_relay.md §Multi-Device Support`'s model ("An
 * app instance on two physical devices requires two subcards — one per
 * device"). A single message sent to the holder's card must independently
 * and correctly reach both devices, each decrypting and verifying with
 * only its own key material, with no dependency between the two
 * deliveries: device B's delivery must succeed even if device A's local
 * store, keys, or processing are entirely absent from this test's
 * treatment of device B (modeled here as two completely separate
 * in-memory stores and no shared state at all between the two
 * "device" simulations beyond the single sender-produced envelope).
 */

const TRUSTED_ROOT = 'aa'.repeat(32);

const fakeIpfs: IpfsProvider = {
  fetch: async () => {
    throw new Error('not used — fetchAnnotations is false');
  },
};

function fakeRpc(): RpcProvider {
  return {
    getCardEntry: async () => null,
    isPolicyAuthorizer: async () => false,
    getPressAuthorization: async () => null,
    getSubCardEntry: async () => null,
    getLogEntries: async () => [],
    getEasAnnotations: async () => [],
  };
}

function makeInMemoryStorage(): StorageProvider {
  const store = new Map<string, Uint8Array>();
  return {
    get: async (key) => store.get(key),
    set: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key) => {
      store.delete(key);
    },
  };
}

describe('Phase 5 Milestone: independent per-subcard message delivery across two simulated device instances', () => {
  it('a single message sent to a card with 2 registered devices is independently, correctly delivered to both — decryption/verification/dedup on one device never depends on the other', async () => {
    // --- Setup: one holder's card, two devices, each with its own sub-card ML-KEM keypair.
    const sender = mlDsa44GenerateKeypair();
    const senderHash = keccak256(sender.publicKey);
    const recipientCardHash = 'r'.repeat(64);

    const deviceA = { subCardHash: 'device-a-subcard', mlKem: mlKem768GenerateKeypair(), storage: makeInMemoryStorage() };
    const deviceB = { subCardHash: 'device-b-subcard', mlKem: mlKem768GenerateKeypair(), storage: makeInMemoryStorage() };

    const subCards: SubCardRecipient[] = [
      { subCardHash: deviceA.subCardHash, mlKemPublicKey: deviceA.mlKem.publicKey },
      { subCardHash: deviceB.subCardHash, mlKemPublicKey: deviceB.mlKem.publicKey },
    ];

    // --- Sender constructs and signs one message, then fans it out (Step 5.1).
    const payload = buildMessagePayload({
      type: 'text',
      content: { body: 'hello both my devices', format: 'plain', attachments: [] },
      recipients: [recipientCardHash],
      senders: [senderHash],
      protocolVersion: '0.1',
    });
    const envelope = await signMessageEnvelope(payload, [
      { publicKey: sender.publicKey, sign: (m) => mlDsa44Sign(sender.secretKey, m) },
    ]);

    const routingEnvelopes = fanOutMessageToSubCards(recipientCardHash, envelope, subCards);
    expect(routingEnvelopes).toHaveLength(2);

    const envelopeForA = routingEnvelopes.find((re) => re.subcard_hash === deviceA.subCardHash)!;
    const envelopeForB = routingEnvelopes.find((re) => re.subcard_hash === deviceB.subCardHash)!;
    expect(envelopeForA.payload).not.toBe(envelopeForB.payload);

    // --- Each device independently receives, decrypts, and verifies (Step 5.2) —
    // using only its own key material and its own storage, never the other's.
    const cardVerifierA = createCardVerifier({
      rpc: fakeRpc(),
      ipfs: fakeIpfs,
      appCertificationRoot: TRUSTED_ROOT,
      trustedRoots: [TRUSTED_ROOT],
      fetchAnnotations: false,
    });
    const cardVerifierB = createCardVerifier({
      rpc: fakeRpc(),
      ipfs: fakeIpfs,
      appCertificationRoot: TRUSTED_ROOT,
      trustedRoots: [TRUSTED_ROOT],
      fetchAnnotations: false,
    });

    const resultA = await handleInboundRoutingEnvelope({
      routingEnvelope: envelopeForA,
      mlKemSecretKey: deviceA.mlKem.secretKey,
      cardVerifier: cardVerifierA,
      storage: deviceA.storage,
    });
    const resultB = await handleInboundRoutingEnvelope({
      routingEnvelope: envelopeForB,
      mlKemSecretKey: deviceB.mlKem.secretKey,
      cardVerifier: cardVerifierB,
      storage: deviceB.storage,
    });

    expect(resultA.accepted).toBe(true);
    expect(resultB.accepted).toBe(true);
    if (resultA.accepted && resultB.accepted) {
      // Both devices recovered the SAME original message content...
      expect(resultA.envelope.payload.content).toEqual(resultB.envelope.payload.content);
      expect(resultA.messageId).toBe(resultB.messageId);
      // ...but each arrived via its own independent ciphertext and its own
      // independent verification run.
      expect(resultA.verification).not.toBe(resultB.verification);
      expect(resultA.duplicate).toBe(false);
      expect(resultB.duplicate).toBe(false);
    }

    // --- Cross-device isolation: device A cannot decrypt device B's copy, and vice versa.
    const crossResult = await handleInboundRoutingEnvelope({
      routingEnvelope: envelopeForB,
      mlKemSecretKey: deviceA.mlKem.secretKey, // wrong key for this routing envelope
      cardVerifier: cardVerifierA,
      storage: makeInMemoryStorage(),
    });
    expect(crossResult.accepted).toBe(false);

    // --- Independent UUID registration for the two devices' subcards, via
    // separate sessions and staggered (Step 5.3) — confirming this
    // milestone's per-subcard model holds through the registration layer
    // too, not just the encryption layer.
    let sessionCounter = 0;
    const transportFactory: ObliviousProtocolTransportFactory = () => {
      sessionCounter++;
      return { request: async () => ({ status: 200, headers: {}, body: new Uint8Array() }) };
    };
    const registrationOutcomes = await registerMultipleCardsUuids({
      transportFactory,
      cards: [
        {
          cardHash: recipientCardHash,
          subCardHash: deviceA.subCardHash,
          uuids: ['a-uuid-1'],
          sign: (m) => mlDsa44Sign(sender.secretKey, m),
          subCardPublicKey: 'unused-in-this-stub',
        },
        {
          cardHash: recipientCardHash,
          subCardHash: deviceB.subCardHash,
          uuids: ['b-uuid-1'],
          sign: (m) => mlDsa44Sign(sender.secretKey, m),
          subCardPublicKey: 'unused-in-this-stub',
        },
      ],
      minStaggerDelayMs: 5,
      maxStaggerDelayMs: 10,
      delay: async () => {},
    });
    expect(registrationOutcomes.every((o) => o.registered)).toBe(true);
    expect(sessionCounter).toBe(2); // one fresh transport/session per device's subcard

    // --- Deregistering device A's subcard must never affect device B's
    // ability to receive future messages — a second message, fanned out
    // again, must still reach device B untouched.
    const deregisterTransport = { request: async () => ({ status: 204, headers: {}, body: new Uint8Array() }) };
    const deregResult = await deregisterCardUuids({
      transport: deregisterTransport,
      cardHash: recipientCardHash,
      subCardHash: deviceA.subCardHash,
      sign: (m) => mlDsa44Sign(sender.secretKey, m),
    });
    expect(deregResult.deregistered).toBe(true);

    const secondPayload = buildMessagePayload({
      type: 'text',
      content: { body: 'second message, after device A deregistered' },
      recipients: [recipientCardHash],
      senders: [senderHash],
      protocolVersion: '0.1',
    });
    const secondEnvelope = await signMessageEnvelope(secondPayload, [
      { publicKey: sender.publicKey, sign: (m) => mlDsa44Sign(sender.secretKey, m) },
    ]);
    // Sender still resolves BOTH sub-cards as registered (deregistration
    // is wallet-service-local bookkeeping, not something that removes the
    // subcard from the on-chain registered list this test's fan-out step
    // consults) — device B must still receive it correctly.
    const secondRoutingEnvelopes = fanOutMessageToSubCards(recipientCardHash, secondEnvelope, subCards);
    const secondEnvelopeForB = secondRoutingEnvelopes.find((re) => re.subcard_hash === deviceB.subCardHash)!;

    const secondResultB = await handleInboundRoutingEnvelope({
      routingEnvelope: secondEnvelopeForB,
      mlKemSecretKey: deviceB.mlKem.secretKey,
      cardVerifier: cardVerifierB,
      storage: deviceB.storage,
    });
    expect(secondResultB.accepted).toBe(true);
  });
});
