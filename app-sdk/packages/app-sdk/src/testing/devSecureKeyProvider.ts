/**
 * An in-memory ML-DSA-44 SecureKeyProvider for development servers and tests
 * (app_sdk.md §9a key custody). Keys live in process memory and are lost on
 * restart. Production sites use a KMS/HSM-backed provider instead.
 */
import { mlDsa44GenerateKeypair, mlDsa44Sign } from '../crypto/index.js';
import type { SecureKeyProvider } from '../providers/SecureKeyProvider.js';

export function createDevSecureKeyProvider(options: { seed?: (keyId: string) => Uint8Array } = {}): SecureKeyProvider {
  const keys = new Map<string, { secretKey: Uint8Array; publicKey: Uint8Array }>();
  return {
    async generateKey(keyId) {
      const kp = mlDsa44GenerateKeypair(options.seed?.(keyId));
      keys.set(keyId, kp);
      return kp.publicKey;
    },
    async sign(keyId, message) {
      const kp = keys.get(keyId);
      if (!kp) throw new Error(`unknown key ${keyId}`);
      return mlDsa44Sign(kp.secretKey, message);
    },
    async getPublicKey(keyId) {
      return keys.get(keyId)?.publicKey;
    },
    async delete(keyId) {
      keys.delete(keyId);
    },
  };
}
