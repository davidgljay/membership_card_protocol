import { gcm } from '@noble/ciphers/aes.js';
import { hkdfSha3256 } from '../crypto/hashes.js';
import { mlKem768Decapsulate } from '../crypto/mlkem.js';
import { base64UrlToBytes } from '../util/base64url.js';
import type { CardMessageEnvelope } from './envelope.js';
import type { RoutingEnvelope } from './fanout.js';

const CONTENT_KEY_INFO = 'card-protocol-message-fanout-v1';
const CONTENT_KEY_LENGTH = 32;

/**
 * Recipient-side counterpart to `fanOutMessageToSubCards` (`fanout.ts`):
 * ML-KEM-decapsulate a `RoutingEnvelope.payload` using this device's
 * sub-card ML-KEM secret key, recovering the inner `CardMessageEnvelope`.
 * Throws on a malformed blob (truncated, bad length prefix) — this is an
 * infrastructure-level failure, not an expected rejection condition; a
 * missing/invalid *signature* inside the recovered envelope is instead
 * surfaced by `verifyInboundEnvelope` (`inbound.ts`, Step 5.2) as a typed
 * result.
 */
export function decryptRoutingEnvelope(
  routingEnvelope: RoutingEnvelope,
  mlKemSecretKey: Uint8Array
): CardMessageEnvelope {
  const blob = base64UrlToBytes(routingEnvelope.payload);
  if (blob.length < 4) {
    throw new Error('decryptRoutingEnvelope: payload too short to contain a length prefix.');
  }
  const cipherTextLength = new DataView(blob.buffer, blob.byteOffset, 4).getUint32(0, false);
  const cipherTextStart = 4;
  const cipherTextEnd = cipherTextStart + cipherTextLength;
  const nonceEnd = cipherTextEnd + 12;
  if (blob.length < nonceEnd) {
    throw new Error('decryptRoutingEnvelope: payload truncated (declared KEM ciphertext length exceeds blob).');
  }

  const kemCipherText = blob.slice(cipherTextStart, cipherTextEnd);
  const nonce = blob.slice(cipherTextEnd, nonceEnd);
  const aeadCiphertext = blob.slice(nonceEnd);

  const sharedSecret = mlKem768Decapsulate(kemCipherText, mlKemSecretKey);
  const contentKey = hkdfSha3256(sharedSecret, CONTENT_KEY_INFO, CONTENT_KEY_LENGTH);
  const plaintext = gcm(contentKey, nonce).decrypt(aeadCiphertext);

  return JSON.parse(new TextDecoder().decode(plaintext)) as CardMessageEnvelope;
}
