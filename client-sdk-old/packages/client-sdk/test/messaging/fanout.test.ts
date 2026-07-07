import { describe, it, expect } from 'vitest';
import { mlDsa44GenerateKeypair, mlDsa44Sign } from '../../src/crypto/mldsa.js';
import { mlKem768GenerateKeypair } from '../../src/crypto/mlkem.js';
import { keccak256 } from '../../src/crypto/hashes.js';
import { buildMessagePayload, signMessageEnvelope } from '../../src/messaging/envelope.js';
import { fanOutMessageToSubCards, type SubCardRecipient } from '../../src/messaging/fanout.js';
import { decryptRoutingEnvelope } from '../../src/messaging/decrypt.js';

describe('fanOutMessageToSubCards (Step 5.1)', () => {
  it('produces exactly 3 distinct ciphertexts for a card with 3 registered sub-cards, each independently decryptable with its own private key', async () => {
    const sender = mlDsa44GenerateKeypair();
    const senderHash = keccak256(sender.publicKey);
    const recipientCardHash = 'r'.repeat(64);

    const subCardKeypairs = [
      mlKem768GenerateKeypair(),
      mlKem768GenerateKeypair(),
      mlKem768GenerateKeypair(),
    ];
    const subCards: SubCardRecipient[] = subCardKeypairs.map((kp, i) => ({
      subCardHash: `subcard-${i}`,
      mlKemPublicKey: kp.publicKey,
    }));

    const payload = buildMessagePayload({
      type: 'text',
      content: { body: 'fan out to all my devices', format: 'plain', attachments: [] },
      recipients: [recipientCardHash],
      senders: [senderHash],
      protocolVersion: '0.1',
    });
    const envelope = await signMessageEnvelope(payload, [
      { publicKey: sender.publicKey, sign: (m) => mlDsa44Sign(sender.secretKey, m) },
    ]);

    const routingEnvelopes = fanOutMessageToSubCards(recipientCardHash, envelope, subCards);

    // Exactly 3 routing envelopes, one per sub-card.
    expect(routingEnvelopes).toHaveLength(3);

    // Not one ciphertext copied 3 times — every payload is distinct.
    const uniquePayloads = new Set(routingEnvelopes.map((re) => re.payload));
    expect(uniquePayloads.size).toBe(3);

    // Each routing envelope names the correct recipient and sub-card.
    routingEnvelopes.forEach((re, i) => {
      expect(re.to).toBe(recipientCardHash);
      expect(re.subcard_hash).toBe(`subcard-${i}`);
    });

    // Each ciphertext decrypts correctly ONLY with its own sub-card's
    // private key, recovering the identical original envelope.
    routingEnvelopes.forEach((re, i) => {
      const decrypted = decryptRoutingEnvelope(re, subCardKeypairs[i]!.secretKey);
      expect(decrypted).toEqual(envelope);
    });

    // Cross-decryption with the WRONG sub-card's key must not succeed
    // (either throws or produces garbage, never the correct envelope).
    let crossDecryptSucceeded = false;
    try {
      const wrongDecrypt = decryptRoutingEnvelope(routingEnvelopes[0]!, subCardKeypairs[1]!.secretKey);
      crossDecryptSucceeded = JSON.stringify(wrongDecrypt) === JSON.stringify(envelope);
    } catch {
      crossDecryptSucceeded = false;
    }
    expect(crossDecryptSucceeded).toBe(false);
  });

  it('throws when the recipient has no registered sub-cards', async () => {
    const sender = mlDsa44GenerateKeypair();
    const payload = buildMessagePayload({
      type: 'text',
      content: { body: 'hi' },
      recipients: ['r'],
      senders: [keccak256(sender.publicKey)],
      protocolVersion: '0.1',
    });
    const envelope = await signMessageEnvelope(payload, [
      { publicKey: sender.publicKey, sign: (m) => mlDsa44Sign(sender.secretKey, m) },
    ]);

    expect(() => fanOutMessageToSubCards('r', envelope, [])).toThrow();
  });
});
