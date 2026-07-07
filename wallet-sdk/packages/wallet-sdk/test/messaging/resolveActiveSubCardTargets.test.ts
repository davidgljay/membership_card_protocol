import { describe, it, expect } from 'vitest';
import { resolveActiveSubCardTargets } from '../../src/index.js';
import { keccak256 } from '@membership-card-protocol/app-sdk';
import type { CardDocument } from '@membership-card-protocol/app-sdk';

describe('resolveActiveSubCardTargets', () => {
  it('returns empty array for card with no active_subcards field', () => {
    const masterCard: CardDocument = {
      policy_id: 'QmTest',
      issuer_card: '0x' + 'a'.repeat(64),
      press_card: '0x' + 'b'.repeat(64),
      press_signature: 'test',
      protocol_version: '0.1',
      recipient_pubkey: 'test',
      issued_at: '2026-01-01T00:00:00Z',
      ancestry_pubkeys: [],
      issuer_signature: 'test',
      holder_signature: 'test',
    };

    const result = resolveActiveSubCardTargets(masterCard);
    expect(result).toEqual([]);
  });

  it('returns empty array for card with empty active_subcards', () => {
    const masterCard: CardDocument = {
      policy_id: 'QmTest',
      issuer_card: '0x' + 'a'.repeat(64),
      press_card: '0x' + 'b'.repeat(64),
      press_signature: 'test',
      protocol_version: '0.1',
      recipient_pubkey: 'test',
      issued_at: '2026-01-01T00:00:00Z',
      ancestry_pubkeys: [],
      active_subcards: [],
      issuer_signature: 'test',
      holder_signature: 'test',
    };

    const result = resolveActiveSubCardTargets(masterCard);
    expect(result).toEqual([]);
  });

  it('resolves single active_subcard entry', () => {
    const pubkeyBytes = new Uint8Array(56).fill(1); // 56 bytes = 1312 bits (ML-DSA-44)
    const pubkeyB64 = Buffer.from(pubkeyBytes).toString('base64url');
    const expectedAddress = keccak256(pubkeyBytes);

    const masterCard: CardDocument = {
      policy_id: 'QmTest',
      issuer_card: '0x' + 'a'.repeat(64),
      press_card: '0x' + 'b'.repeat(64),
      press_signature: 'test',
      protocol_version: '0.1',
      recipient_pubkey: 'test',
      issued_at: '2026-01-01T00:00:00Z',
      ancestry_pubkeys: [],
      active_subcards: [pubkeyB64],
      issuer_signature: 'test',
      holder_signature: 'test',
    };

    const result = resolveActiveSubCardTargets(masterCard);
    expect(result).toHaveLength(1);
    expect(result[0]!.pubkey).toBe(pubkeyB64);
    expect(result[0]!.address).toBe(expectedAddress);
  });

  it('resolves multiple active_subcard entries', () => {
    const pubkey1 = new Uint8Array(56).fill(1);
    const pubkey2 = new Uint8Array(56).fill(2);
    const pubkey1B64 = Buffer.from(pubkey1).toString('base64url');
    const pubkey2B64 = Buffer.from(pubkey2).toString('base64url');

    const masterCard: CardDocument = {
      policy_id: 'QmTest',
      issuer_card: '0x' + 'a'.repeat(64),
      press_card: '0x' + 'b'.repeat(64),
      press_signature: 'test',
      protocol_version: '0.1',
      recipient_pubkey: 'test',
      issued_at: '2026-01-01T00:00:00Z',
      ancestry_pubkeys: [],
      active_subcards: [pubkey1B64, pubkey2B64],
      issuer_signature: 'test',
      holder_signature: 'test',
    };

    const result = resolveActiveSubCardTargets(masterCard);
    expect(result).toHaveLength(2);
    expect(result[0]!.pubkey).toBe(pubkey1B64);
    expect(result[1]!.pubkey).toBe(pubkey2B64);
    // Addresses should be different
    expect(result[0]!.address).not.toBe(result[1]!.address);
  });

  it('gracefully handles edge case entries', () => {
    const validPubkey = new Uint8Array(56).fill(1);
    const validB64 = Buffer.from(validPubkey).toString('base64url');

    const masterCard: CardDocument = {
      policy_id: 'QmTest',
      issuer_card: '0x' + 'a'.repeat(64),
      press_card: '0x' + 'b'.repeat(64),
      press_signature: 'test',
      protocol_version: '0.1',
      recipient_pubkey: 'test',
      issued_at: '2026-01-01T00:00:00Z',
      ancestry_pubkeys: [],
      active_subcards: [validB64, validB64],
      issuer_signature: 'test',
      holder_signature: 'test',
    };

    const result = resolveActiveSubCardTargets(masterCard);
    // Should successfully decode both valid entries
    expect(result).toHaveLength(2);
    expect(result[0]!.pubkey).toBe(validB64);
    expect(result[1]!.pubkey).toBe(validB64);
  });

  it('treats non-array active_subcards as no sub-cards', () => {
    const masterCard: any = {
      policy_id: 'QmTest',
      issuer_card: '0x' + 'a'.repeat(64),
      press_card: '0x' + 'b'.repeat(64),
      press_signature: 'test',
      protocol_version: '0.1',
      recipient_pubkey: 'test',
      issued_at: '2026-01-01T00:00:00Z',
      ancestry_pubkeys: [],
      active_subcards: 'not-an-array',
      issuer_signature: 'test',
      holder_signature: 'test',
    };

    const result = resolveActiveSubCardTargets(masterCard);
    expect(result).toEqual([]);
  });

  it('addresses are lowercase hex without 0x prefix', () => {
    const pubkeyBytes = new Uint8Array(56).fill(255);
    const pubkeyB64 = Buffer.from(pubkeyBytes).toString('base64url');

    const masterCard: CardDocument = {
      policy_id: 'QmTest',
      issuer_card: '0x' + 'a'.repeat(64),
      press_card: '0x' + 'b'.repeat(64),
      press_signature: 'test',
      protocol_version: '0.1',
      recipient_pubkey: 'test',
      issued_at: '2026-01-01T00:00:00Z',
      ancestry_pubkeys: [],
      active_subcards: [pubkeyB64],
      issuer_signature: 'test',
      holder_signature: 'test',
    };

    const result = resolveActiveSubCardTargets(masterCard);
    expect(result[0]!.address).toMatch(/^[0-9a-f]{64}$/);
  });
});
