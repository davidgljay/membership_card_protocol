import type { SecureKeyProvider } from '@membership-card-protocol/app-sdk';
import { mlDsa44GenerateKeypair, mlDsa44Sign } from '@membership-card-protocol/app-sdk';
import { SECURE_KEY_STORE, idbGet, idbPut, idbDelete } from './indexeddb.js';

interface StoredKeyRecord {
  publicKey: Uint8Array;
  wrappingKey: CryptoKey;
  iv: Uint8Array;
  wrappedSecretKey: Uint8Array;
}

/**
 * Default web `SecureKeyProvider` (OQ-SDK-1): a non-extractable WebCrypto
 * `CryptoKey` AES-GCM-wraps the ML-DSA-44 secret key, and the wrapped key
 * is persisted via IndexedDB.
 *
 * Software-only — there is no hardware key store backing this on web,
 * unlike the Secure Enclave / StrongBox-backed React Native default. This
 * is a disclosed, deliberate security-posture gap: the non-extractable
 * wrapping key prevents casual key exfiltration (code cannot read the raw
 * wrapping key bytes back out of IndexedDB), but does not protect against
 * a compromised page decrypting the wrapped secret key at sign time — a
 * guarantee only real hardware custody can make. Host apps should surface
 * persistent messaging recommending the native app for stronger custody,
 * per OQ-SDK-1's resolution.
 */
export class WebCryptoSecureKeyProvider implements SecureKeyProvider {
  async generateKey(keyId: string): Promise<Uint8Array> {
    const { publicKey, secretKey } = mlDsa44GenerateKeypair();
    const wrappingKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wrappedSecretKey = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, new Uint8Array(secretKey))
    );
    const record: StoredKeyRecord = { publicKey, wrappingKey, iv, wrappedSecretKey };
    await idbPut(SECURE_KEY_STORE, keyId, record);
    return publicKey;
  }

  async sign(keyId: string, message: Uint8Array): Promise<Uint8Array> {
    const record = await idbGet<StoredKeyRecord>(SECURE_KEY_STORE, keyId);
    if (!record) {
      throw new Error(`WebCryptoSecureKeyProvider: no key found for keyId "${keyId}"`);
    }
    const secretKeyBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(record.iv) },
      record.wrappingKey,
      new Uint8Array(record.wrappedSecretKey)
    );
    return mlDsa44Sign(new Uint8Array(secretKeyBuffer), message);
  }

  async getPublicKey(keyId: string): Promise<Uint8Array | undefined> {
    const record = await idbGet<StoredKeyRecord>(SECURE_KEY_STORE, keyId);
    return record?.publicKey;
  }

  async delete(keyId: string): Promise<void> {
    await idbDelete(SECURE_KEY_STORE, keyId);
  }
}
