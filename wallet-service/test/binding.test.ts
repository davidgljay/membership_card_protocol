import { describe, it, expect } from 'vitest';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { keccak_256 } from '@noble/hashes/sha3';
import {
  buildRegistrationAnnouncement,
  verifyAnnouncementEnvelope,
  shouldAcceptAnnouncement,
  type CardBindingAnnouncementPayload,
  type AnnouncementEnvelope,
} from '../src/federation/binding.js';
import { canonicalize } from '../src/canonicalize.js';
import type { RoutingTableRow } from '../server/db/routing.js';

function walletServiceKeys() {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const keys = ml_dsa44.keygen(seed);
  const id = '0x' + Buffer.from(keccak_256(keys.publicKey)).toString('hex');
  return { ...keys, id };
}

function cardholderKeys() {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const keys = ml_dsa44.keygen(seed);
  const cardHash = '0x' + Buffer.from(keccak_256(keys.publicKey)).toString('hex');
  return { ...keys, cardHash };
}

describe('buildRegistrationAnnouncement / verifyAnnouncementEnvelope', () => {
  it('builds a self-consistent, independently verifiable registration announcement', () => {
    const ws = walletServiceKeys();
    const envelope = buildRegistrationAnnouncement('0xcardhash', ws.id, 'https://ws.example.com', ws.secretKey);

    expect(envelope.payload.type).toBe('card_registration');
    const result = verifyAnnouncementEnvelope(envelope);
    expect(result.ok).toBe(true);
  });

  it('rejects a registration with no wallet_service signature', () => {
    const ws = walletServiceKeys();
    const envelope = buildRegistrationAnnouncement('0xcardhash', ws.id, 'https://ws.example.com', ws.secretKey);
    const tampered: AnnouncementEnvelope = { ...envelope, signatures: [] };
    const result = verifyAnnouncementEnvelope(tampered);
    expect(result.ok).toBe(false);
  });

  it('rejects when the wallet_service public key does not hash to the claimed wallet_service_id', () => {
    const ws = walletServiceKeys();
    const otherWs = walletServiceKeys();
    const envelope = buildRegistrationAnnouncement('0xcardhash', ws.id, 'https://ws.example.com', ws.secretKey);
    // swap in a different (validly-signing) key whose hash doesn't match payload.wallet_service_id
    const forged: AnnouncementEnvelope = {
      ...envelope,
      signatures: [
        {
          public_key: Buffer.from(otherWs.publicKey).toString('base64url'),
          role: 'wallet_service',
          signature: Buffer.from(ml_dsa44.sign(canonicalize(envelope.payload), otherWs.secretKey)).toString(
            'base64url'
          ),
        },
      ],
    };
    const result = verifyAnnouncementEnvelope(forged);
    expect(result.ok).toBe(false);
  });

  it('rejects a tampered payload (signature no longer matches)', () => {
    const ws = walletServiceKeys();
    const envelope = buildRegistrationAnnouncement('0xcardhash', ws.id, 'https://ws.example.com', ws.secretKey);
    const tampered: AnnouncementEnvelope = {
      ...envelope,
      payload: { ...envelope.payload, endpoint: 'https://attacker.example.com' },
    };
    const result = verifyAnnouncementEnvelope(tampered);
    expect(result.ok).toBe(false);
  });

  it('requires a cardholder signature for card_migration, matching keccak256(pubkey) == card_hash', () => {
    const ws = walletServiceKeys();
    const cardholder = cardholderKeys();

    const payload: CardBindingAnnouncementPayload = {
      type: 'card_migration',
      card_hash: cardholder.cardHash,
      wallet_service_id: ws.id,
      endpoint: 'https://ws.example.com',
      timestamp: new Date().toISOString(),
      nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
    };
    const message = canonicalize(payload);
    const wsSig = ml_dsa44.sign(message, ws.secretKey);

    // missing cardholder signature
    const missingCardholder: AnnouncementEnvelope = {
      payload,
      signatures: [
        { public_key: Buffer.from(ws.publicKey).toString('base64url'), role: 'wallet_service', signature: Buffer.from(wsSig).toString('base64url') },
      ],
    };
    expect(verifyAnnouncementEnvelope(missingCardholder).ok).toBe(false);

    // valid cardholder signature present
    const cardholderSig = ml_dsa44.sign(message, cardholder.secretKey);
    const complete: AnnouncementEnvelope = {
      payload,
      signatures: [
        { public_key: Buffer.from(ws.publicKey).toString('base64url'), role: 'wallet_service', signature: Buffer.from(wsSig).toString('base64url') },
        { public_key: Buffer.from(cardholder.publicKey).toString('base64url'), role: 'cardholder', signature: Buffer.from(cardholderSig).toString('base64url') },
      ],
    };
    expect(verifyAnnouncementEnvelope(complete).ok).toBe(true);
  });

  it('rejects a card_migration where the cardholder pubkey does not match card_hash', () => {
    const ws = walletServiceKeys();
    const cardholder = cardholderKeys();
    const wrongCardholder = cardholderKeys();

    const payload: CardBindingAnnouncementPayload = {
      type: 'card_migration',
      card_hash: cardholder.cardHash,
      wallet_service_id: ws.id,
      endpoint: 'https://ws.example.com',
      timestamp: new Date().toISOString(),
      nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
    };
    const message = canonicalize(payload);
    const envelope: AnnouncementEnvelope = {
      payload,
      signatures: [
        { public_key: Buffer.from(ws.publicKey).toString('base64url'), role: 'wallet_service', signature: Buffer.from(ml_dsa44.sign(message, ws.secretKey)).toString('base64url') },
        { public_key: Buffer.from(wrongCardholder.publicKey).toString('base64url'), role: 'cardholder', signature: Buffer.from(ml_dsa44.sign(message, wrongCardholder.secretKey)).toString('base64url') },
      ],
    };
    expect(verifyAnnouncementEnvelope(envelope).ok).toBe(false);
  });
});

function row(overrides: Partial<RoutingTableRow> = {}): RoutingTableRow {
  return {
    card_hash: '0xcardhash',
    wallet_service_id: '0xws1',
    endpoint: 'https://ws1.example.com',
    type: 'card_registration',
    announced_at: new Date('2026-01-01T00:00:00Z'),
    nonce: 'nonce-1',
    signatures: [],
    ...overrides,
  };
}

function payload(overrides: Partial<CardBindingAnnouncementPayload> = {}): CardBindingAnnouncementPayload {
  return {
    type: 'card_registration',
    card_hash: '0xcardhash',
    wallet_service_id: '0xws2',
    endpoint: 'https://ws2.example.com',
    timestamp: '2026-01-02T00:00:00Z',
    nonce: 'nonce-2',
    ...overrides,
  };
}

describe('shouldAcceptAnnouncement (message_routing.md §Binding Conflict Resolution)', () => {
  it('accepts when there is no existing entry', () => {
    expect(shouldAcceptAnnouncement(null, payload())).toBe(true);
  });

  it('migration always supersedes registration, regardless of timestamp', () => {
    const existing = row({ type: 'card_registration', announced_at: new Date('2026-06-01T00:00:00Z') });
    const incoming = payload({ type: 'card_migration', timestamp: '2026-01-01T00:00:00Z' }); // earlier timestamp
    expect(shouldAcceptAnnouncement(existing, incoming)).toBe(true);
  });

  it('registration never supersedes an existing migration, regardless of timestamp', () => {
    const existing = row({ type: 'card_migration', announced_at: new Date('2026-01-01T00:00:00Z') });
    const incoming = payload({ type: 'card_registration', timestamp: '2026-06-01T00:00:00Z' }); // later timestamp
    expect(shouldAcceptAnnouncement(existing, incoming)).toBe(false);
  });

  it('between two registrations, the later timestamp wins', () => {
    const existing = row({ type: 'card_registration', announced_at: new Date('2026-01-01T00:00:00Z') });
    const later = payload({ type: 'card_registration', timestamp: '2026-06-01T00:00:00Z' });
    const earlier = payload({ type: 'card_registration', timestamp: '2025-01-01T00:00:00Z' });
    expect(shouldAcceptAnnouncement(existing, later)).toBe(true);
    expect(shouldAcceptAnnouncement(existing, earlier)).toBe(false);
  });

  it('between two migrations, the later timestamp wins', () => {
    const existing = row({ type: 'card_migration', announced_at: new Date('2026-01-01T00:00:00Z') });
    const later = payload({ type: 'card_migration', timestamp: '2026-06-01T00:00:00Z' });
    const earlier = payload({ type: 'card_migration', timestamp: '2025-01-01T00:00:00Z' });
    expect(shouldAcceptAnnouncement(existing, later)).toBe(true);
    expect(shouldAcceptAnnouncement(existing, earlier)).toBe(false);
  });

  it('out-of-order delivery still converges correctly (applying earlier-timestamped announcement after a later one is a no-op)', () => {
    const existing = row({ type: 'card_registration', announced_at: new Date('2026-06-01T00:00:00Z') });
    // a stale announcement arriving late should not displace the newer one
    const stale = payload({ type: 'card_registration', timestamp: '2026-01-01T00:00:00Z' });
    expect(shouldAcceptAnnouncement(existing, stale)).toBe(false);
  });
});
