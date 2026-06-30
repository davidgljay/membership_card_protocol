/**
 * Default SecretsBackend (strategic-plan.md §Secret Storage). Master key is
 * a platform secret (Cloudflare Worker secret / env var on node-server and
 * aws-lambda). Wrap/unwrap use the runtime's native Web Crypto AES-256-GCM
 * — no external service call.
 *
 * Wire format: base64url(iv[12] || ciphertext+tag).
 */

import type { SecretsBackend } from './backend.js';

const IV_BYTES = 12;

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

// Buffer's backing ArrayBufferLike can be a SharedArrayBuffer, which the
// Web Crypto API's BufferSource type rejects under exactOptionalPropertyTypes
// / strict lib.dom typings. Uint8Array.from() copies into a fresh,
// plain-ArrayBuffer-backed Uint8Array.
function freshBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes) as Uint8Array<ArrayBuffer>;
}

function fromBase64Url(str: string): Uint8Array<ArrayBuffer> {
  return freshBytes(Buffer.from(str, 'base64url'));
}

export class WebCryptoBackend implements SecretsBackend {
  private readonly masterKeyPromise: Promise<CryptoKey>;

  constructor(masterKeyBase64Url: string) {
    const raw = fromBase64Url(masterKeyBase64Url);
    if (raw.length !== 32) {
      throw new Error(`WebCryptoBackend: master key must be 32 bytes, got ${raw.length}.`);
    }
    this.masterKeyPromise = crypto.subtle.importKey(
      'raw',
      raw,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async wrapDek(dek: Buffer): Promise<string> {
    const key = await this.masterKeyPromise;
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, freshBytes(dek));
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return toBase64Url(combined);
  }

  async unwrapDek(dekEnc: string): Promise<Buffer> {
    const key = await this.masterKeyPromise;
    const combined = fromBase64Url(dekEnc);
    if (combined.length <= IV_BYTES) {
      throw new Error('WebCryptoBackend: ciphertext too short.');
    }
    const iv = combined.slice(0, IV_BYTES);
    const ciphertext = combined.slice(IV_BYTES);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return Buffer.from(plaintext);
  }
}
