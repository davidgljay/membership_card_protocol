import { describe, it, expect, vi } from 'vitest';
import {
  addActiveSubCard,
  removeActiveSubCard,
  rotateActiveSubCard,
  type UpdateSubcardsResult,
} from '../../src/subcards/activeSubcardsUpdate.js';
import { canonicalize } from '../../src/crypto/canonicalize.js';
import { mlDsa44GenerateKeypair, mlDsa44Sign, mlDsa44Verify } from '../../src/crypto/mldsa.js';
import { base64UrlToBytes } from '../../src/util/base64url.js';
import type {
  ObliviousProtocolTransport,
  ObliviousDestination,
  RequestOptions,
  ObliviousResponse,
} from '../../src/providers/ObliviousProtocolTransport.js';

function jsonResponse(status: number, body: unknown): ObliviousResponse {
  return { status, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
}

function readJsonBody(options: RequestOptions): Record<string, unknown> {
  if (!options.body) return {};
  return JSON.parse(new TextDecoder().decode(options.body)) as Record<string, unknown>;
}

const PRESS_BASE_URL = 'https://press.example';
const HOLDER_CARD_POINTER = 'holder-master-card-pointer';

function makeStubPress() {
  const calls: Array<{ destination: ObliviousDestination; body: Record<string, unknown> }> = [];
  const transport: ObliviousProtocolTransport = {
    request: vi.fn(async (destination: ObliviousDestination, options: RequestOptions) => {
      const body = readJsonBody(options);
      calls.push({ destination, body });
      return jsonResponse(200, { log_entry_cid: 'log-entry-cid', new_log_head_cid: 'new-log-head-cid' });
    }),
  };
  return { transport, calls };
}

describe('activeSubcardsUpdate', () => {
  describe('addActiveSubCard (code 510)', () => {
    it('successfully adds a pubkey to active_subcards', async () => {
      const { transport, calls } = makeStubPress();
      const holderKey = mlDsa44GenerateKeypair();
      const holder = {
        cardPointer: HOLDER_CARD_POINTER,
        sign: (message: Uint8Array) => mlDsa44Sign(holderKey.secretKey, message),
      };

      const newPubkey = Buffer.from(new Uint8Array(56).fill(1)).toString('base64url');
      const existingPubkey = Buffer.from(new Uint8Array(56).fill(2)).toString('base64url');
      const newActiveSubcards = [existingPubkey, newPubkey];

      const result = await addActiveSubCard({
        transport,
        pressBaseUrl: PRESS_BASE_URL,
        holderCardPointer: HOLDER_CARD_POINTER,
        holder,
        newActiveSubcards,
        note: 'device registered',
      });

      expect(result).toEqual({ logEntryCid: 'log-entry-cid', newLogHeadCid: 'new-log-head-cid' });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.destination).toEqual({ kind: 'press', baseUrl: PRESS_BASE_URL });

      const body = calls[0]!.body;
      const updateIntent = body.update_intent as Record<string, unknown>;
      expect(updateIntent.target_card).toBe(HOLDER_CARD_POINTER);
      expect(updateIntent.updater_card).toBe(HOLDER_CARD_POINTER);
      expect(updateIntent.code).toBe(510);
      expect(updateIntent.field_updates).toEqual([
        {
          field: 'active_subcards',
          value: newActiveSubcards,
        },
      ]);
      expect('revocation' in updateIntent).toBe(false);
      expect(updateIntent.note).toBe('device registered');
      expect(updateIntent.notify_holder).toBe(true);

      const signature = base64UrlToBytes(body.intent_signature as string);
      expect(mlDsa44Verify(holderKey.publicKey, canonicalize(updateIntent), signature)).toBe(true);
    });

    it('includes a timestamp field for replay prevention', async () => {
      const { transport, calls } = makeStubPress();
      const holderKey = mlDsa44GenerateKeypair();
      const holder = {
        cardPointer: HOLDER_CARD_POINTER,
        sign: (message: Uint8Array) => mlDsa44Sign(holderKey.secretKey, message),
      };

      const newPubkey = Buffer.from(new Uint8Array(56).fill(1)).toString('base64url');

      await addActiveSubCard({
        transport,
        pressBaseUrl: PRESS_BASE_URL,
        holderCardPointer: HOLDER_CARD_POINTER,
        holder,
        newActiveSubcards: [newPubkey],
      });

      const updateIntent = calls[0]!.body.update_intent as Record<string, unknown>;
      expect(updateIntent.timestamp).toEqual(expect.any(String));
      expect(new Date(updateIntent.timestamp as string).getTime()).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('removeActiveSubCard (code 511)', () => {
    it('successfully removes a pubkey from active_subcards', async () => {
      const { transport, calls } = makeStubPress();
      const holderKey = mlDsa44GenerateKeypair();
      const holder = {
        cardPointer: HOLDER_CARD_POINTER,
        sign: (message: Uint8Array) => mlDsa44Sign(holderKey.secretKey, message),
      };

      const removedPubkey = Buffer.from(new Uint8Array(56).fill(1)).toString('base64url');
      const remainingPubkey = Buffer.from(new Uint8Array(56).fill(2)).toString('base64url');
      const newActiveSubcards = [remainingPubkey];

      const result = await removeActiveSubCard({
        transport,
        pressBaseUrl: PRESS_BASE_URL,
        holderCardPointer: HOLDER_CARD_POINTER,
        holder,
        newActiveSubcards,
        note: 'app uninstalled',
      });

      expect(result).toEqual({ logEntryCid: 'log-entry-cid', newLogHeadCid: 'new-log-head-cid' });
      expect(calls).toHaveLength(1);

      const body = calls[0]!.body;
      const updateIntent = body.update_intent as Record<string, unknown>;
      expect(updateIntent.code).toBe(511);
      expect(updateIntent.field_updates).toEqual([
        {
          field: 'active_subcards',
          value: newActiveSubcards,
        },
      ]);
      expect(updateIntent.note).toBe('app uninstalled');

      const signature = base64UrlToBytes(body.intent_signature as string);
      expect(mlDsa44Verify(holderKey.publicKey, canonicalize(updateIntent), signature)).toBe(true);
    });
  });

  describe('rotateActiveSubCard (code 512)', () => {
    it('atomically rotates one pubkey for another in active_subcards', async () => {
      const { transport, calls } = makeStubPress();
      const holderKey = mlDsa44GenerateKeypair();
      const holder = {
        cardPointer: HOLDER_CARD_POINTER,
        sign: (message: Uint8Array) => mlDsa44Sign(holderKey.secretKey, message),
      };

      const oldPubkey = Buffer.from(new Uint8Array(56).fill(1)).toString('base64url');
      const newPubkey = Buffer.from(new Uint8Array(56).fill(2)).toString('base64url');
      const unchangedPubkey = Buffer.from(new Uint8Array(56).fill(3)).toString('base64url');
      const newActiveSubcards = [newPubkey, unchangedPubkey];

      const result = await rotateActiveSubCard({
        transport,
        pressBaseUrl: PRESS_BASE_URL,
        holderCardPointer: HOLDER_CARD_POINTER,
        holder,
        newActiveSubcards,
        note: 'device key compromised, rotating',
      });

      expect(result).toEqual({ logEntryCid: 'log-entry-cid', newLogHeadCid: 'new-log-head-cid' });
      expect(calls).toHaveLength(1);

      const body = calls[0]!.body;
      const updateIntent = body.update_intent as Record<string, unknown>;
      expect(updateIntent.code).toBe(512);
      expect(updateIntent.field_updates).toEqual([
        {
          field: 'active_subcards',
          value: newActiveSubcards,
        },
      ]);
      // Verify it's a single atomic entry, not multiple field_updates
      expect((updateIntent.field_updates as Array<unknown>).length).toBe(1);

      const signature = base64UrlToBytes(body.intent_signature as string);
      expect(mlDsa44Verify(holderKey.publicKey, canonicalize(updateIntent), signature)).toBe(true);
    });
  });

  describe('holder-only authorization', () => {
    it('signs with holder key (target_card and updater_card must be identical)', async () => {
      const { transport, calls } = makeStubPress();
      const holderKey = mlDsa44GenerateKeypair();
      const holder = {
        cardPointer: HOLDER_CARD_POINTER,
        sign: (message: Uint8Array) => mlDsa44Sign(holderKey.secretKey, message),
      };

      const newPubkey = Buffer.from(new Uint8Array(56).fill(1)).toString('base64url');

      await addActiveSubCard({
        transport,
        pressBaseUrl: PRESS_BASE_URL,
        holderCardPointer: HOLDER_CARD_POINTER,
        holder,
        newActiveSubcards: [newPubkey],
      });

      const updateIntent = calls[0]!.body.update_intent as Record<string, unknown>;
      // Both target and updater must be the holder's own card (holder-only authorization per spec)
      expect(updateIntent.target_card).toBe(HOLDER_CARD_POINTER);
      expect(updateIntent.updater_card).toBe(HOLDER_CARD_POINTER);

      const signature = base64UrlToBytes(calls[0]!.body.intent_signature as string);
      // Signature must be valid with the holder key
      expect(mlDsa44Verify(holderKey.publicKey, canonicalize(updateIntent), signature)).toBe(true);
    });
  });

  describe('error handling', () => {
    it('throws on a non-2xx response from the press (code 510)', async () => {
      const holderKey = mlDsa44GenerateKeypair();
      const transport: ObliviousProtocolTransport = {
        request: vi.fn(async () => jsonResponse(403, { error: 'not authorized' })),
      };

      await expect(
        addActiveSubCard({
          transport,
          pressBaseUrl: PRESS_BASE_URL,
          holderCardPointer: HOLDER_CARD_POINTER,
          holder: { cardPointer: HOLDER_CARD_POINTER, sign: (m) => mlDsa44Sign(holderKey.secretKey, m) },
          newActiveSubcards: [],
        })
      ).rejects.toThrow(/returned status 403/);
    });

    it('throws on a non-2xx response from the press (code 511)', async () => {
      const holderKey = mlDsa44GenerateKeypair();
      const transport: ObliviousProtocolTransport = {
        request: vi.fn(async () => jsonResponse(500, { error: 'internal error' })),
      };

      await expect(
        removeActiveSubCard({
          transport,
          pressBaseUrl: PRESS_BASE_URL,
          holderCardPointer: HOLDER_CARD_POINTER,
          holder: { cardPointer: HOLDER_CARD_POINTER, sign: (m) => mlDsa44Sign(holderKey.secretKey, m) },
          newActiveSubcards: [],
        })
      ).rejects.toThrow(/returned status 500/);
    });

    it('throws on a non-2xx response from the press (code 512)', async () => {
      const holderKey = mlDsa44GenerateKeypair();
      const transport: ObliviousProtocolTransport = {
        request: vi.fn(async () => jsonResponse(401, { error: 'invalid signature' })),
      };

      await expect(
        rotateActiveSubCard({
          transport,
          pressBaseUrl: PRESS_BASE_URL,
          holderCardPointer: HOLDER_CARD_POINTER,
          holder: { cardPointer: HOLDER_CARD_POINTER, sign: (m) => mlDsa44Sign(holderKey.secretKey, m) },
          newActiveSubcards: [],
        })
      ).rejects.toThrow(/returned status 401/);
    });
  });

  describe('notification handling', () => {
    it('notifyHolder defaults to true', async () => {
      const { transport, calls } = makeStubPress();
      const holderKey = mlDsa44GenerateKeypair();
      const holder = {
        cardPointer: HOLDER_CARD_POINTER,
        sign: (message: Uint8Array) => mlDsa44Sign(holderKey.secretKey, message),
      };

      await addActiveSubCard({
        transport,
        pressBaseUrl: PRESS_BASE_URL,
        holderCardPointer: HOLDER_CARD_POINTER,
        holder,
        newActiveSubcards: [],
        // notifyHolder not specified
      });

      const updateIntent = calls[0]!.body.update_intent as Record<string, unknown>;
      expect(updateIntent.notify_holder).toBe(true);
    });

    it('respects notifyHolder: false', async () => {
      const { transport, calls } = makeStubPress();
      const holderKey = mlDsa44GenerateKeypair();
      const holder = {
        cardPointer: HOLDER_CARD_POINTER,
        sign: (message: Uint8Array) => mlDsa44Sign(holderKey.secretKey, message),
      };

      await addActiveSubCard({
        transport,
        pressBaseUrl: PRESS_BASE_URL,
        holderCardPointer: HOLDER_CARD_POINTER,
        holder,
        newActiveSubcards: [],
        notifyHolder: false,
      });

      const updateIntent = calls[0]!.body.update_intent as Record<string, unknown>;
      expect(updateIntent.notify_holder).toBe(false);
    });
  });
});
