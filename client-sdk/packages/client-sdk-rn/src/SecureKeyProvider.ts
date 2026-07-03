import * as Keychain from 'react-native-keychain';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/hashes/utils.js';
import type { SecureKeyProvider } from '@membership-card-protocol/client-sdk';
import { mlDsa44GenerateKeypair, mlDsa44Sign } from '@membership-card-protocol/client-sdk';
import { bytesToBase64Url, base64UrlToBytes } from './base64url.js';
import { AsyncStorageProvider } from './StorageProvider.js';

const KEYCHAIN_SERVICE_PREFIX = 'membership-card-protocol-client-sdk:wrapping-key:';
const WRAPPED_KEY_NAMESPACE = 'secure-key-provider';

interface WrappedKeyRecord {
  publicKey: string; // base64url
  nonce: string; // base64url
  wrappedSecretKey: string; // base64url
}

/**
 * Default React Native `SecureKeyProvider`: intended to match
 * `subcards.md §Non-Exportability` — Secure Enclave (iOS,
 * `kSecAttrTokenIDSecureEnclave`) / StrongBox-backed `AndroidKeyStore`
 * (Android) — via `react-native-keychain`'s `SECURE_HARDWARE` security
 * level.
 *
 * **Disclosed limitation, distinct from OQ-SDK-1's web-specific gap:** no
 * current mobile HSM (Secure Enclave, StrongBox) natively supports
 * ML-DSA-44 (post-quantum) key generation or signing — those APIs only
 * support classical algorithms (ECDSA, RSA, AES). So this provider cannot
 * literally generate/sign with the ML-DSA-44 key *inside* hardware, as
 * `subcards.md`'s prose describes idealized. Instead, exactly as the web
 * default does: a random AES-256-GCM wrapping key is generated and stored
 * via `react-native-keychain` at `SECURE_HARDWARE` — the OS enforces that
 * this wrapping key never leaves the hardware-backed keystore in
 * extractable form — and it wraps the ML-DSA-44 secret key, which is
 * decrypted into JS memory only transiently, for the duration of a single
 * `sign()` call. This is a real, meaningful step up from the web default
 * (OS-enforced hardware custody of the wrapping key vs. software
 * WebCrypto), but the underlying industry limitation — no hardware-native
 * post-quantum signing on mobile today — applies to any SDK building on
 * ML-DSA-44, not just this one.
 *
 * **Host app requirement:** React Native / Hermes does not provide
 * `crypto.getRandomValues` by default. The host app must install and
 * import `react-native-get-random-values` (or an equivalent polyfill)
 * before this provider — or any ML-DSA-44 key generation anywhere in
 * `@membership-card-protocol/client-sdk` — is used, or key generation
 * will either throw or silently fall back to a non-CSPRNG source
 * depending on the platform. This applies to the whole SDK on RN, not
 * just this provider.
 */
export class SecureEnclaveKeyProvider implements SecureKeyProvider {
  readonly #wrappedKeyStore: AsyncStorageProvider;

  constructor() {
    this.#wrappedKeyStore = new AsyncStorageProvider(WRAPPED_KEY_NAMESPACE);
  }

  async generateKey(keyId: string): Promise<Uint8Array> {
    const { publicKey, secretKey } = mlDsa44GenerateKeypair();
    const wrappingKey = randomBytes(32);
    const nonce = randomBytes(12);
    const wrappedSecretKey = gcm(wrappingKey, nonce).encrypt(secretKey);

    await Keychain.setGenericPassword('client-sdk', bytesToBase64Url(wrappingKey), {
      service: this.#keychainService(keyId),
      securityLevel: Keychain.SECURITY_LEVEL.SECURE_HARDWARE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });

    const record: WrappedKeyRecord = {
      publicKey: bytesToBase64Url(publicKey),
      nonce: bytesToBase64Url(nonce),
      wrappedSecretKey: bytesToBase64Url(wrappedSecretKey),
    };
    await this.#wrappedKeyStore.set(keyId, new TextEncoder().encode(JSON.stringify(record)));

    return publicKey;
  }

  async sign(keyId: string, message: Uint8Array): Promise<Uint8Array> {
    const record = await this.#getRecord(keyId);
    if (!record) {
      throw new Error(`SecureEnclaveKeyProvider: no key found for keyId "${keyId}"`);
    }
    const wrappingKeyCredentials = await Keychain.getGenericPassword({
      service: this.#keychainService(keyId),
    });
    if (!wrappingKeyCredentials) {
      throw new Error(`SecureEnclaveKeyProvider: no wrapping key in keystore for keyId "${keyId}"`);
    }
    const wrappingKey = base64UrlToBytes(wrappingKeyCredentials.password);
    const nonce = base64UrlToBytes(record.nonce);
    const wrappedSecretKey = base64UrlToBytes(record.wrappedSecretKey);
    const secretKey = gcm(wrappingKey, nonce).decrypt(wrappedSecretKey);
    return mlDsa44Sign(secretKey, message);
  }

  async getPublicKey(keyId: string): Promise<Uint8Array | undefined> {
    const record = await this.#getRecord(keyId);
    return record ? base64UrlToBytes(record.publicKey) : undefined;
  }

  async delete(keyId: string): Promise<void> {
    await Keychain.resetGenericPassword({ service: this.#keychainService(keyId) });
    await this.#wrappedKeyStore.delete(keyId);
  }

  #keychainService(keyId: string): string {
    return `${KEYCHAIN_SERVICE_PREFIX}${keyId}`;
  }

  async #getRecord(keyId: string): Promise<WrappedKeyRecord | undefined> {
    const raw = await this.#wrappedKeyStore.get(keyId);
    return raw ? (JSON.parse(new TextDecoder().decode(raw)) as WrappedKeyRecord) : undefined;
  }
}
