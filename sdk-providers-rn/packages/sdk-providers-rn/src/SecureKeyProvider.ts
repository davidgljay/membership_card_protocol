import * as Keychain from 'react-native-keychain';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/hashes/utils.js';
import type { SecureKeyProvider } from '@membership-card-protocol/app-sdk';
import {
  mlDsa44GenerateKeypair,
  mlDsa44Sign,
  bytesToBase64Url,
  base64UrlToBytes,
} from '@membership-card-protocol/app-sdk';
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
 * **Hardware backing is the norm on RN, but is device-dependent, and is
 * never available on web.** Requesting `SECURITY_LEVEL.SECURE_HARDWARE`
 * (line below) is the expected case on real iOS/Android hardware — most
 * devices in practice have a Secure Enclave or StrongBox-backed keystore —
 * but `react-native-keychain` also defines `SECURE_SOFTWARE` and `ANY`
 * precisely because hardware backing isn't universal (e.g. some older or
 * budget Android devices lack a StrongBox module); on a device without one,
 * the underlying OS keystore falls back to a software-backed store rather
 * than failing outright. This is a meaningful platform difference from the
 * web default (`WebCryptoSecureKeyProvider`), which has no hardware-backed
 * option on any device — IndexedDB-backed WebCrypto is always software-only,
 * per OQ-SDK-1.
 *
 * **Disclosed limitation, distinct from OQ-SDK-1's web-specific gap:** no
 * current mobile HSM (Secure Enclave, StrongBox) natively supports
 * ML-DSA-44 (post-quantum) key generation or signing — those APIs only
 * support classical algorithms (ECDSA, RSA, AES). So this provider cannot
 * literally generate/sign with the ML-DSA-44 key *inside* hardware, as
 * `subcards.md`'s prose describes idealized. Instead, exactly as the web
 * default does: a random AES-256-GCM wrapping key is generated and stored
 * via `react-native-keychain` at `SECURE_HARDWARE` (when available on the
 * device) — the OS hardware-backs the wrapping key's storage and gates
 * access to it (e.g. behind biometric/passcode unlock, depending on
 * `ACCESSIBLE`), but `Keychain.getGenericPassword()` is a plaintext
 * *retrieval* API: the wrapping key is fetched into ordinary JS-accessible
 * memory on every `sign()` call, not operated on from inside the hardware
 * boundary. It then wraps/unwraps the ML-DSA-44 secret key the same way the
 * web provider does, with the plaintext secret key existing in JS memory
 * only transiently, for the duration of a single `sign()` call. This is a
 * real, meaningful step up from the web default (OS-enforced, potentially
 * hardware-backed *at-rest* protection and access-gating for the wrapping
 * key, vs. software-only WebCrypto) — but it is at-rest protection, not
 * confinement of the key from JS at use time, and the underlying industry
 * limitation — no hardware-native post-quantum signing on mobile today —
 * applies to any SDK building on ML-DSA-44, not just this one.
 *
 * **Host app requirement:** React Native / Hermes does not provide
 * `crypto.getRandomValues` by default. The host app must install and
 * import `react-native-get-random-values` (or an equivalent polyfill)
 * before this provider — or any ML-DSA-44 key generation anywhere in
 * `@membership-card-protocol/app-sdk` — is used, or key generation
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
