import { describe, it, expect } from 'vitest';
import { mlDsa44GenerateKeypair, mlDsa44Sign, mlDsa44Verify } from '../../src/crypto/mldsa.js';
import { keccak256 } from '../../src/crypto/hashes.js';
import {
  buildMessagePayload,
  signMessageEnvelope,
  messageId,
  type EnvelopeSigner,
} from '../../src/messaging/envelope.js';
import { canonicalize } from '../../src/crypto/canonicalize.js';

function signerFrom(keypair: { publicKey: Uint8Array; secretKey: Uint8Array }): EnvelopeSigner {
  return {
    publicKey: keypair.publicKey,
    sign: (message) => mlDsa44Sign(keypair.secretKey, message),
  };
}

describe('buildMessagePayload / signMessageEnvelope', () => {
  it('matches the spec fixture shape for a text message', async () => {
    const sender = mlDsa44GenerateKeypair();
    const senderHash = keccak256(sender.publicKey);
    const recipientHash = 'a'.repeat(64);

    const payload = buildMessagePayload({
      type: 'text',
      content: { body: 'hello', format: 'plain', attachments: [] },
      recipients: [recipientHash],
      senders: [senderHash],
      protocolVersion: '0.1',
    });

    expect(payload.type).toBe('text');
    expect(payload.recipients).toEqual([recipientHash]);
    expect(payload.senders).toEqual([senderHash]);
    expect(payload.protocol_version).toBe('0.1');
    expect(payload.edit_of).toBeUndefined();
    expect(payload.retracts).toBeUndefined();
    expect(payload.forwards).toBeUndefined();
    expect('edit_of' in payload).toBe(false);

    const envelope = await signMessageEnvelope(payload, [signerFrom(sender)]);
    expect(envelope.signatures).toHaveLength(1);
    expect(envelope.signatures[0]!.public_key).toBeTruthy();
    expect(envelope.signatures[0]!.signature).toBeTruthy();
  });

  it('produces a verifiable signature over the canonical payload', async () => {
    const sender = mlDsa44GenerateKeypair();
    const payload = buildMessagePayload({
      type: 'reply',
      content: { body: 'yes', format: 'plain' },
      recipients: ['b'.repeat(64)],
      senders: [keccak256(sender.publicKey)],
      protocolVersion: '0.1',
      inReplyTo: 'deadbeef',
    });
    const envelope = await signMessageEnvelope(payload, [signerFrom(sender)]);

    const canonicalPayload = canonicalize(envelope.payload);
    const sig = envelope.signatures[0]!;
    const valid = mlDsa44Verify(
      base64UrlDecode(sig.public_key),
      canonicalPayload,
      base64UrlDecode(sig.signature)
    );
    expect(valid).toBe(true);
  });

  it('every implemented message type constructs without error', async () => {
    const sender = mlDsa44GenerateKeypair();
    const senderHash = keccak256(sender.publicKey);
    const recipientHash = 'c'.repeat(64);

    const fixtures: Array<{ type: Parameters<typeof buildMessagePayload>[0]['type']; content: Record<string, unknown>; extra?: Record<string, unknown> }> = [
      { type: 'text', content: { body: 'hi', format: 'plain', attachments: [] } },
      { type: 'reply', content: { body: 'hi', format: 'plain' }, extra: { inReplyTo: 'x' } },
      { type: 'edit', content: { body: 'hi2', format: 'plain' }, extra: { editOf: 'x' } },
      { type: 'reaction', content: { emoji: '👍', target: 'x', retract: false } },
      { type: 'read_receipt', content: { target: 'x', delivered: new Date().toISOString(), read: new Date().toISOString() } },
      { type: 'card_offer', content: { offer_cid: 'cid1', policy_pointer: 'p1', issuer_signature: 'sig', expires: new Date().toISOString() } },
      { type: 'card_offer_accepted', content: { card_cid: 'cid2', offer_cid: 'cid1', holder_signature: 'sig', recipient_pubkey: 'pk' } },
      { type: 'card_offer_declined', content: { offer_cid: 'cid1' } },
      { type: 'card_update_notification', content: { card_pointer: 'p1', update_code: 100, log_entry_cid: 'cid3' } },
      { type: 'auth_request', content: { requester_card: 'p1', policy_cid: 'cid4', nonce: 'n', purpose: 'login', session_id: 's1', callback: 'https://example.com/cb', expires: new Date().toISOString() } },
      { type: 'auth_response', content: { statement: 'I am me', context: { session_id: 's1' }, nonce: 'n' } },
    ];

    for (const fixture of fixtures) {
      const payload = buildMessagePayload({
        type: fixture.type,
        content: fixture.content,
        recipients: [recipientHash],
        senders: [senderHash],
        protocolVersion: '0.1',
        ...(fixture.extra as Record<string, unknown>),
      });
      const envelope = await signMessageEnvelope(payload, [signerFrom(sender)]);
      expect(envelope.payload.type).toBe(fixture.type);
    }
  });

  it('rejects edit_of/retracts/forwards set together (mutually exclusive)', () => {
    expect(() =>
      buildMessagePayload({
        type: 'text',
        content: {},
        recipients: ['a'],
        senders: ['b'],
        protocolVersion: '0.1',
        editOf: 'x',
        retracts: 'y',
      })
    ).toThrow();
  });

  it('rejects type "edit" without edit_of', () => {
    expect(() =>
      buildMessagePayload({
        type: 'edit',
        content: {},
        recipients: ['a'],
        senders: ['b'],
        protocolVersion: '0.1',
      })
    ).toThrow();
  });

  it('rejects type "edit" with retracts set', () => {
    expect(() =>
      buildMessagePayload({
        type: 'edit',
        content: {},
        recipients: ['a'],
        senders: ['b'],
        protocolVersion: '0.1',
        editOf: 'x',
        retracts: 'y',
      })
    ).toThrow();
  });

  it('messageId is the keccak256 hash of the canonical payload, stable across re-serialization', () => {
    const payload = buildMessagePayload({
      type: 'text',
      content: { body: 'hi' },
      recipients: ['a'],
      senders: ['b'],
      protocolVersion: '0.1',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    const id1 = messageId(payload);
    const id2 = messageId(JSON.parse(JSON.stringify(payload)));
    expect(id1).toBe(id2);
    expect(id1).toBe(keccak256(canonicalize(payload)));
  });
});

function base64UrlDecode(input: string): Uint8Array {
  const cleaned = input.replace(/-/g, '+').replace(/_/g, '/');
  return new Uint8Array(Buffer.from(cleaned, 'base64'));
}
