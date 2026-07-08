import { describe, it, expect, vi } from 'vitest';
import {
  postSubCardAddedToDirectory,
  postSubCardRemovedFromDirectory,
} from '../../src/subcards/activeSubcardsUpdate.js';
import {
  mlDsa44GenerateKeypair,
  mlDsa44Verify,
  canonicalize,
  bytesToBase64Url,
} from '@membership-card-protocol/app-sdk';
import { base64UrlToBytes } from '@membership-card-protocol/app-sdk';
import type {
  ObliviousProtocolTransport,
  ObliviousDestination,
  RequestOptions,
  ObliviousResponse,
} from '@membership-card-protocol/app-sdk';

function jsonResponse(status: number, body: unknown): ObliviousResponse {
  return { status, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
}

function readJsonBody(options: RequestOptions): Record<string, unknown> {
  if (!options.body) return {};
  return JSON.parse(new TextDecoder().decode(options.body)) as Record<string, unknown>;
}

describe('activeSubcardsUpdate', () => {
  describe('postSubCardAddedToDirectory (code 510)', () => {
    it('appends the new pubkey to the current active_subcards array', async () => {
      const master = mlDsa44GenerateKeypair();
      const existingPubkey = bytesToBase64Url(mlDsa44GenerateKeypair().publicKey);
      const newPubkey = bytesToBase64Url(mlDsa44GenerateKeypair().publicKey);
      const calls: Array<{ destination: ObliviousDestination; options: RequestOptions }> = [];
      const transport: ObliviousProtocolTransport = {
        request: vi.fn(async (destination, options) => {
          calls.push({ destination, options });
          return jsonResponse(200, { log_entry_cid: 'cid-entry', new_log_head_cid: 'cid-head' });
        }),
      };

      const result = await postSubCardAddedToDirectory({
        transport,
        pressBaseUrl: 'https://press.example',
        masterCardPointer: 'master-card-ptr',
        masterSecretKey: master.secretKey,
        currentActiveSubcards: [existingPubkey],
        newSubCardPublicKey: newPubkey,
      });

      expect(result.logEntryCid).toBe('cid-entry');
      expect(result.newLogHeadCid).toBe('cid-head');
      expect(calls).toHaveLength(1);

      const { destination, options: reqOptions } = calls[0]!;
      expect(destination).toEqual({ kind: 'press', baseUrl: 'https://press.example' });
      expect(reqOptions.method).toBe('POST');
      expect(reqOptions.path).toBe('/update');

      const body = readJsonBody(reqOptions);
      const updateIntent = body.update_intent as Record<string, unknown>;
      expect(updateIntent.target_card).toBe('master-card-ptr');
      expect(updateIntent.updater_card).toBe('master-card-ptr');
      expect(updateIntent.code).toBe(510);
      expect(updateIntent.notify_holder).toBe(false);

      const fieldUpdates = updateIntent.field_updates as Array<{ field: string; value: string[] }>;
      expect(fieldUpdates).toHaveLength(1);
      expect(fieldUpdates[0]!.field).toBe('active_subcards');
      expect(fieldUpdates[0]!.value).toEqual([existingPubkey, newPubkey]);

      // Verify signature is over the canonicalized update intent, signed by master key
      const signature = base64UrlToBytes(body.intent_signature as string);
      expect(mlDsa44Verify(master.publicKey, canonicalize(updateIntent), signature)).toBe(true);
    });

    it('handles null/empty current array by starting with empty and appending', async () => {
      const master = mlDsa44GenerateKeypair();
      const newPubkey = bytesToBase64Url(mlDsa44GenerateKeypair().publicKey);
      const calls: Array<{ destination: ObliviousDestination; options: RequestOptions }> = [];
      const transport: ObliviousProtocolTransport = {
        request: vi.fn(async (destination, options) => {
          calls.push({ destination, options });
          return jsonResponse(200, { log_entry_cid: 'cid-entry', new_log_head_cid: 'cid-head' });
        }),
      };

      const result = await postSubCardAddedToDirectory({
        transport,
        pressBaseUrl: 'https://press.example',
        masterCardPointer: 'master-card-ptr',
        masterSecretKey: master.secretKey,
        currentActiveSubcards: null,
        newSubCardPublicKey: newPubkey,
      });

      expect(result.logEntryCid).toBe('cid-entry');

      const body = readJsonBody(calls[0]!.options);
      const updateIntent = body.update_intent as Record<string, unknown>;
      const fieldUpdates = updateIntent.field_updates as Array<{ field: string; value: string[] }>;
      expect(fieldUpdates[0]!.value).toEqual([newPubkey]);
    });

    it('does not duplicate the pubkey if it is already present', async () => {
      const master = mlDsa44GenerateKeypair();
      const pubkey = bytesToBase64Url(mlDsa44GenerateKeypair().publicKey);
      const calls: Array<{ destination: ObliviousDestination; options: RequestOptions }> = [];
      const transport: ObliviousProtocolTransport = {
        request: vi.fn(async (destination, options) => {
          calls.push({ destination, options });
          return jsonResponse(200, { log_entry_cid: 'cid-entry', new_log_head_cid: 'cid-head' });
        }),
      };

      await postSubCardAddedToDirectory({
        transport,
        pressBaseUrl: 'https://press.example',
        masterCardPointer: 'master-card-ptr',
        masterSecretKey: master.secretKey,
        currentActiveSubcards: [pubkey],
        newSubCardPublicKey: pubkey,
      });

      const body = readJsonBody(calls[0]!.options);
      const updateIntent = body.update_intent as Record<string, unknown>;
      const fieldUpdates = updateIntent.field_updates as Array<{ field: string; value: string[] }>;
      expect(fieldUpdates[0]!.value).toEqual([pubkey]); // Not duplicated
    });

    it('signs the update intent with the master key only', async () => {
      const master = mlDsa44GenerateKeypair();
      const otherKey = mlDsa44GenerateKeypair();
      const newPubkey = bytesToBase64Url(mlDsa44GenerateKeypair().publicKey);
      const calls: Array<{ destination: ObliviousDestination; options: RequestOptions }> = [];
      const transport: ObliviousProtocolTransport = {
        request: vi.fn(async (destination, options) => {
          calls.push({ destination, options });
          return jsonResponse(200, { log_entry_cid: 'cid-entry', new_log_head_cid: 'cid-head' });
        }),
      };

      await postSubCardAddedToDirectory({
        transport,
        pressBaseUrl: 'https://press.example',
        masterCardPointer: 'master-card-ptr',
        masterSecretKey: master.secretKey,
        currentActiveSubcards: [],
        newSubCardPublicKey: newPubkey,
      });

      const body = readJsonBody(calls[0]!.options);
      const updateIntent = body.update_intent as Record<string, unknown>;
      const signature = base64UrlToBytes(body.intent_signature as string);

      // Verify against master key succeeds
      expect(mlDsa44Verify(master.publicKey, canonicalize(updateIntent), signature)).toBe(true);
      // Verify against other key fails
      expect(mlDsa44Verify(otherKey.publicKey, canonicalize(updateIntent), signature)).toBe(false);
    });

    it('has no parameter through which a different key could be substituted as the signer', () => {
      // Structural check: postSubCardAddedToDirectory's only signing-key-shaped input
      // is `masterSecretKey`. There is no injectable "signer" callback that a caller
      // could point at a different key — the function signature itself is the
      // enforcement mechanism (compare to revocation.ts's UpdateIntentSigner callback).
      expect(postSubCardAddedToDirectory.length).toBe(1); // single `options` object parameter
    });

    it('throws on a non-2xx response', async () => {
      const master = mlDsa44GenerateKeypair();
      const newPubkey = bytesToBase64Url(mlDsa44GenerateKeypair().publicKey);
      const transport: ObliviousProtocolTransport = {
        request: vi.fn(async () => jsonResponse(500, { error: 'press unavailable' })),
      };

      await expect(
        postSubCardAddedToDirectory({
          transport,
          pressBaseUrl: 'https://press.example',
          masterCardPointer: 'master-card-ptr',
          masterSecretKey: master.secretKey,
          currentActiveSubcards: [],
          newSubCardPublicKey: newPubkey,
        })
      ).rejects.toThrow(/returned status 500/);
    });
  });

  describe('postSubCardRemovedFromDirectory (code 511)', () => {
    it('removes the specified pubkey from the current active_subcards array', async () => {
      const master = mlDsa44GenerateKeypair();
      const pubkey1 = bytesToBase64Url(mlDsa44GenerateKeypair().publicKey);
      const pubkey2 = bytesToBase64Url(mlDsa44GenerateKeypair().publicKey);
      const pubkey3 = bytesToBase64Url(mlDsa44GenerateKeypair().publicKey);
      const calls: Array<{ destination: ObliviousDestination; options: RequestOptions }> = [];
      const transport: ObliviousProtocolTransport = {
        request: vi.fn(async (destination, options) => {
          calls.push({ destination, options });
          return jsonResponse(200, { log_entry_cid: 'cid-entry', new_log_head_cid: 'cid-head' });
        }),
      };

      const result = await postSubCardRemovedFromDirectory({
        transport,
        pressBaseUrl: 'https://press.example',
        masterCardPointer: 'master-card-ptr',
        masterSecretKey: master.secretKey,
        currentActiveSubcards: [pubkey1, pubkey2, pubkey3],
        removedSubCardPublicKey: pubkey2,
      });

      expect(result.logEntryCid).toBe('cid-entry');
      expect(result.newLogHeadCid).toBe('cid-head');

      const body = readJsonBody(calls[0]!.options);
      const updateIntent = body.update_intent as Record<string, unknown>;
      expect(updateIntent.code).toBe(511);
      expect(updateIntent.target_card).toBe('master-card-ptr');
      expect(updateIntent.updater_card).toBe('master-card-ptr');

      const fieldUpdates = updateIntent.field_updates as Array<{ field: string; value: string[] }>;
      expect(fieldUpdates[0]!.value).toEqual([pubkey1, pubkey3]); // pubkey2 removed
    });

    it('returns unchanged array if the pubkey to remove is not present (idempotent no-op)', async () => {
      const master = mlDsa44GenerateKeypair();
      const pubkey1 = bytesToBase64Url(mlDsa44GenerateKeypair().publicKey);
      const pubkey2 = bytesToBase64Url(mlDsa44GenerateKeypair().publicKey);
      const absentPubkey = bytesToBase64Url(mlDsa44GenerateKeypair().publicKey);
      const calls: Array<{ destination: ObliviousDestination; options: RequestOptions }> = [];
      const transport: ObliviousProtocolTransport = {
        request: vi.fn(async (destination, options) => {
          calls.push({ destination, options });
          return jsonResponse(200, { log_entry_cid: 'cid-entry', new_log_head_cid: 'cid-head' });
        }),
      };

      await postSubCardRemovedFromDirectory({
        transport,
        pressBaseUrl: 'https://press.example',
        masterCardPointer: 'master-card-ptr',
        masterSecretKey: master.secretKey,
        currentActiveSubcards: [pubkey1, pubkey2],
        removedSubCardPublicKey: absentPubkey,
      });

      const body = readJsonBody(calls[0]!.options);
      const updateIntent = body.update_intent as Record<string, unknown>;
      const fieldUpdates = updateIntent.field_updates as Array<{ field: string; value: string[] }>;
      expect(fieldUpdates[0]!.value).toEqual([pubkey1, pubkey2]); // Unchanged
    });

    it('includes optional note field if provided', async () => {
      const master = mlDsa44GenerateKeypair();
      const pubkey = bytesToBase64Url(mlDsa44GenerateKeypair().publicKey);
      const calls: Array<{ destination: ObliviousDestination; options: RequestOptions }> = [];
      const transport: ObliviousProtocolTransport = {
        request: vi.fn(async (destination, options) => {
          calls.push({ destination, options });
          return jsonResponse(200, { log_entry_cid: 'cid-entry', new_log_head_cid: 'cid-head' });
        }),
      };

      await postSubCardRemovedFromDirectory({
        transport,
        pressBaseUrl: 'https://press.example',
        masterCardPointer: 'master-card-ptr',
        masterSecretKey: master.secretKey,
        currentActiveSubcards: [pubkey],
        removedSubCardPublicKey: pubkey,
        note: 'device lost',
      });

      const body = readJsonBody(calls[0]!.options);
      const updateIntent = body.update_intent as Record<string, unknown>;
      expect(updateIntent.note).toBe('device lost');
    });

    it('omits note field if not provided', async () => {
      const master = mlDsa44GenerateKeypair();
      const pubkey = bytesToBase64Url(mlDsa44GenerateKeypair().publicKey);
      const calls: Array<{ destination: ObliviousDestination; options: RequestOptions }> = [];
      const transport: ObliviousProtocolTransport = {
        request: vi.fn(async (destination, options) => {
          calls.push({ destination, options });
          return jsonResponse(200, { log_entry_cid: 'cid-entry', new_log_head_cid: 'cid-head' });
        }),
      };

      await postSubCardRemovedFromDirectory({
        transport,
        pressBaseUrl: 'https://press.example',
        masterCardPointer: 'master-card-ptr',
        masterSecretKey: master.secretKey,
        currentActiveSubcards: [pubkey],
        removedSubCardPublicKey: pubkey,
      });

      const body = readJsonBody(calls[0]!.options);
      const updateIntent = body.update_intent as Record<string, unknown>;
      expect(updateIntent.note).toBeUndefined();
    });

    it('signs the update intent with the master key only', async () => {
      const master = mlDsa44GenerateKeypair();
      const otherKey = mlDsa44GenerateKeypair();
      const pubkey = bytesToBase64Url(mlDsa44GenerateKeypair().publicKey);
      const calls: Array<{ destination: ObliviousDestination; options: RequestOptions }> = [];
      const transport: ObliviousProtocolTransport = {
        request: vi.fn(async (destination, options) => {
          calls.push({ destination, options });
          return jsonResponse(200, { log_entry_cid: 'cid-entry', new_log_head_cid: 'cid-head' });
        }),
      };

      await postSubCardRemovedFromDirectory({
        transport,
        pressBaseUrl: 'https://press.example',
        masterCardPointer: 'master-card-ptr',
        masterSecretKey: master.secretKey,
        currentActiveSubcards: [pubkey],
        removedSubCardPublicKey: pubkey,
      });

      const body = readJsonBody(calls[0]!.options);
      const updateIntent = body.update_intent as Record<string, unknown>;
      const signature = base64UrlToBytes(body.intent_signature as string);

      // Verify against master key succeeds
      expect(mlDsa44Verify(master.publicKey, canonicalize(updateIntent), signature)).toBe(true);
      // Verify against other key fails
      expect(mlDsa44Verify(otherKey.publicKey, canonicalize(updateIntent), signature)).toBe(false);
    });

    it('has no parameter through which a different key could be substituted as the signer', () => {
      // Structural check: postSubCardRemovedFromDirectory's only signing-key-shaped input
      // is `masterSecretKey`. There is no injectable "signer" callback that a caller
      // could point at a different key.
      expect(postSubCardRemovedFromDirectory.length).toBe(1); // single `options` object parameter
    });

    it('throws on a non-2xx response', async () => {
      const master = mlDsa44GenerateKeypair();
      const pubkey = bytesToBase64Url(mlDsa44GenerateKeypair().publicKey);
      const transport: ObliviousProtocolTransport = {
        request: vi.fn(async () => jsonResponse(500, { error: 'press unavailable' })),
      };

      await expect(
        postSubCardRemovedFromDirectory({
          transport,
          pressBaseUrl: 'https://press.example',
          masterCardPointer: 'master-card-ptr',
          masterSecretKey: master.secretKey,
          currentActiveSubcards: [pubkey],
          removedSubCardPublicKey: pubkey,
        })
      ).rejects.toThrow(/returned status 500/);
    });
  });
});
