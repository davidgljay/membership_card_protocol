import { describe, it, expect } from 'vitest';
import type { IpfsProvider, RpcProvider } from '@membership-card-protocol/verifier';
import { createCardVerifier } from '../../src/verification/CardVerifier.js';
import { mlDsa44GenerateKeypair, mlDsa44Sign } from '../../src/crypto/mldsa.js';
import { mlKem768GenerateKeypair } from '../../src/crypto/mlkem.js';
import { keccak256 } from '../../src/crypto/hashes.js';
import { buildMessagePayload, signMessageEnvelope } from '../../src/messaging/envelope.js';
import { fanOutMessageToSubCards, type SubCardRecipient } from '../../src/messaging/fanout.js';
import {
  handleInboundRoutingEnvelope,
  editTarget,
  reactionTarget,
  retractionTarget,
  resolveEditRoot,
} from '../../src/messaging/inbound.js';
import { messageId } from '../../src/messaging/envelope.js';
import type { StorageProvider } from '../../src/providers/StorageProvider.js';

const TRUSTED_ROOT = 'aa'.repeat(32);

const fakeIpfs: IpfsProvider = {
  fetch: async () => {
    throw new Error('not used — fetchAnnotations is false');
  },
};

function fakeRpc(overrides: Partial<RpcProvider> = {}): RpcProvider {
  return {
    getCardEntry: async () => null,
    isPolicyAuthorizer: async () => false,
    getPressAuthorization: async () => null,
    getSubCardEntry: async () => null,
    getLogEntries: async () => [],
    getEasAnnotations: async () => [],
    ...overrides,
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

async function buildRoutingEnvelopeFixture() {
  const sender = mlDsa44GenerateKeypair();
  const senderHash = keccak256(sender.publicKey);
  const recipientCardHash = 'r'.repeat(64);
  const subCardKeypair = mlKem768GenerateKeypair();
  const subCards: SubCardRecipient[] = [{ subCardHash: 'subcard-0', mlKemPublicKey: subCardKeypair.publicKey }];

  const payload = buildMessagePayload({
    type: 'text',
    content: { body: 'hello inbound', format: 'plain', attachments: [] },
    recipients: [recipientCardHash],
    senders: [senderHash],
    protocolVersion: '0.1',
  });
  const envelope = await signMessageEnvelope(payload, [
    { publicKey: sender.publicKey, sign: (m) => mlDsa44Sign(sender.secretKey, m) },
  ]);
  const [routingEnvelope] = fanOutMessageToSubCards(recipientCardHash, envelope, subCards);

  return {
    routingEnvelope: routingEnvelope!,
    mlKemSecretKey: subCardKeypair.secretKey,
    mlKemPublicKey: subCardKeypair.publicKey,
    recipientCardHash,
    envelope,
  };
}

describe('handleInboundRoutingEnvelope (Step 5.2)', () => {
  it('accepts a validly signed envelope after decryption, via verifyEnvelope (not a hand-rolled check)', async () => {
    const { routingEnvelope, mlKemSecretKey } = await buildRoutingEnvelopeFixture();
    const cardVerifier = createCardVerifier({
      rpc: fakeRpc(),
      ipfs: fakeIpfs,
      appCertificationRoot: TRUSTED_ROOT,
      trustedRoots: [TRUSTED_ROOT],
      fetchAnnotations: false,
    });
    const storage = makeInMemoryStorage();

    const result = await handleInboundRoutingEnvelope({
      routingEnvelope,
      mlKemSecretKey,
      cardVerifier,
      storage,
    });

    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.verification.signatures[0]!.signature_valid).toBe(true);
      expect(result.duplicate).toBe(false);
    }
  });

  it('rejects an envelope with an invalid signature via the verifier result — never displayed', async () => {
    const { mlKemSecretKey, mlKemPublicKey, recipientCardHash, envelope } = await buildRoutingEnvelopeFixture();

    // Tamper with the signed payload after signing (simulates a forged or
    // corrupted envelope) — re-encrypt the tampered envelope through the
    // same fan-out path so the routing envelope's ciphertext carries the
    // tampered content, exactly as a malicious or corrupted relay might
    // deliver. Signatures were computed over the original payload, so
    // verifying against the tampered one must fail.
    const tamperedEnvelope = {
      ...envelope,
      payload: { ...envelope.payload, content: { ...envelope.payload.content, body: 'tampered' } },
    };
    const subCards: SubCardRecipient[] = [{ subCardHash: 'subcard-0', mlKemPublicKey }];
    const [tamperedRoutingEnvelope] = fanOutMessageToSubCards(recipientCardHash, tamperedEnvelope, subCards);

    const cardVerifier = createCardVerifier({
      rpc: fakeRpc(),
      ipfs: fakeIpfs,
      appCertificationRoot: TRUSTED_ROOT,
      trustedRoots: [TRUSTED_ROOT],
      fetchAnnotations: false,
    });
    const storage = makeInMemoryStorage();

    const result = await handleInboundRoutingEnvelope({
      routingEnvelope: tamperedRoutingEnvelope!,
      mlKemSecretKey,
      cardVerifier,
      storage,
    });

    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.code).toBe('no_valid_signature');
    }
  });

  it('a retransmitted duplicate (same message ID, simulated relay-restart) is stored once, not twice', async () => {
    const { routingEnvelope, mlKemSecretKey } = await buildRoutingEnvelopeFixture();
    const cardVerifier = createCardVerifier({
      rpc: fakeRpc(),
      ipfs: fakeIpfs,
      appCertificationRoot: TRUSTED_ROOT,
      trustedRoots: [TRUSTED_ROOT],
      fetchAnnotations: false,
    });
    const storage = makeInMemoryStorage();
    const setSpy: string[] = [];
    const originalSet = storage.set.bind(storage);
    storage.set = async (key, value) => {
      setSpy.push(key);
      return originalSet(key, value);
    };

    const first = await handleInboundRoutingEnvelope({ routingEnvelope, mlKemSecretKey, cardVerifier, storage });
    // Simulate relay restart: the exact same routing envelope (same
    // ciphertext, since fan-out is deterministic per this fixture — a
    // real device receives the *identical* payload retransmitted, per
    // message_routing.md) arrives again.
    const second = await handleInboundRoutingEnvelope({ routingEnvelope, mlKemSecretKey, cardVerifier, storage });

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    if (first.accepted && second.accepted) {
      expect(first.messageId).toBe(second.messageId);
      expect(first.duplicate).toBe(false);
      expect(second.duplicate).toBe(true);
    }
    // Only one write for this message's history key, not two.
    expect(setSpy.filter((k) => k.includes(first.accepted ? first.messageId : ''))).toHaveLength(1);
  });
});

describe('message-type-specific handling helpers (Step 5.2)', () => {
  it('editTarget returns edit_of for an edit message', () => {
    const payload = buildMessagePayload({
      type: 'edit',
      content: { body: 'v2', format: 'plain' },
      recipients: ['r'],
      senders: ['s'],
      protocolVersion: '0.1',
      editOf: 'original-hash',
    });
    expect(editTarget(payload)).toBe('original-hash');
  });

  it('reactionTarget returns content.target for a reaction message', () => {
    const payload = buildMessagePayload({
      type: 'reaction',
      content: { emoji: '🎉', target: 'target-hash', retract: false },
      recipients: ['r'],
      senders: ['s'],
      protocolVersion: '0.1',
    });
    expect(reactionTarget(payload)).toBe('target-hash');
  });

  it('retractionTarget returns the envelope-level retracts field when present', () => {
    const payload = buildMessagePayload({
      type: 'text',
      content: { body: '' },
      recipients: ['r'],
      senders: ['s'],
      protocolVersion: '0.1',
      retracts: 'retracted-hash',
    });
    expect(retractionTarget(payload)).toBe('retracted-hash');
  });

  it('resolveEditRoot follows edit_of pointers to the original, edit_of-less payload', async () => {
    const original = buildMessagePayload({
      type: 'text',
      content: { body: 'v1' },
      recipients: ['r'],
      senders: ['s'],
      protocolVersion: '0.1',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    const originalId = messageId(original);

    const edit1 = buildMessagePayload({
      type: 'edit',
      content: { body: 'v2', format: 'plain' },
      recipients: ['r'],
      senders: ['s'],
      protocolVersion: '0.1',
      editOf: originalId,
      timestamp: '2026-01-01T00:01:00.000Z',
    });
    const edit1Id = messageId(edit1);

    const edit2 = buildMessagePayload({
      type: 'edit',
      content: { body: 'v3', format: 'plain' },
      recipients: ['r'],
      senders: ['s'],
      protocolVersion: '0.1',
      editOf: edit1Id,
      timestamp: '2026-01-01T00:02:00.000Z',
    });

    const store = new Map([
      [originalId, original],
      [edit1Id, edit1],
    ]);
    const root = await resolveEditRoot(edit2, async (hash) => store.get(hash));
    expect(root).toBe(originalId);
  });
});
