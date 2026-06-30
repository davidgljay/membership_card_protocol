/**
 * SecretsService: envelope encryption for service_secret only (Step 1.3).
 * UMBRAL re-encryption keys are stored in plaintext per OQ-WS-4 and need no
 * service.
 *
 * Each encrypt generates a random 256-bit DEK, encrypts the plaintext with
 * AES-256-GCM under the DEK, then wraps the DEK via the configured
 * SecretsBackend. Unwrapped DEKs are cached in process memory for a short
 * TTL so repeated decryptSecret calls for the same DEK avoid a backend
 * round-trip (relevant mainly for KmsBackend, which is subject to AWS rate
 * limits per strategic-plan.md).
 */

import type { SecretsBackend } from './backend.js';

const DEK_BYTES = 32;
const IV_BYTES = 12;
const DEK_CACHE_TTL_MS = 10 * 60 * 1000;

// Buffer's backing ArrayBufferLike can be a SharedArrayBuffer, which the Web
// Crypto API's BufferSource type rejects under strict lib.dom typings.
function freshBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes) as Uint8Array<ArrayBuffer>;
}

export interface EncryptedSecret {
  ciphertext: string;
  dekEnc: string;
}

interface CacheEntry {
  dek: Buffer;
  expiresAt: number;
}

export class SecretsService {
  private readonly backend: SecretsBackend;
  private readonly dekCache = new Map<string, CacheEntry>();

  constructor(backend: SecretsBackend) {
    this.backend = backend;
  }

  async encryptSecret(plaintext: Buffer): Promise<EncryptedSecret> {
    const dek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
    const key = await crypto.subtle.importKey('raw', dek, { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertextBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, freshBytes(plaintext));

    const combined = new Uint8Array(iv.length + ciphertextBuf.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertextBuf), iv.length);

    const dekEnc = await this.backend.wrapDek(Buffer.from(dek));

    return {
      ciphertext: Buffer.from(combined).toString('base64url'),
      dekEnc,
    };
  }

  async decryptSecret(ciphertext: string, dekEnc: string): Promise<Buffer> {
    const dek = await this.getDek(dekEnc);
    const key = await crypto.subtle.importKey('raw', freshBytes(dek), { name: 'AES-GCM' }, false, ['decrypt']);

    const combined = freshBytes(Buffer.from(ciphertext, 'base64url'));
    if (combined.length <= IV_BYTES) {
      throw new Error('SecretsService: ciphertext too short.');
    }
    const iv = combined.subarray(0, IV_BYTES);
    const ct = combined.subarray(IV_BYTES);

    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return Buffer.from(plaintext);
  }

  private async getDek(dekEnc: string): Promise<Buffer> {
    const cached = this.dekCache.get(dekEnc);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.dek;
    }
    const dek = await this.backend.unwrapDek(dekEnc);
    this.dekCache.set(dekEnc, { dek, expiresAt: now + DEK_CACHE_TTL_MS });
    return dek;
  }
}
