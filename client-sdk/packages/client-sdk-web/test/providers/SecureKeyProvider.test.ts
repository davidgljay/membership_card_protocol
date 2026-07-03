import { describe, it, expect } from 'vitest';
import { secureKeyProviderContractTests } from '@membership-card-protocol/client-sdk/testing';
import { mlDsa44Verify } from '@membership-card-protocol/client-sdk';
import { WebCryptoSecureKeyProvider } from '../../src/SecureKeyProvider.js';

describe('WebCryptoSecureKeyProvider contract', () => {
  for (const [name, run] of Object.entries(
    secureKeyProviderContractTests(async () => new WebCryptoSecureKeyProvider())
  )) {
    it(name, run);
  }
});

describe('WebCryptoSecureKeyProvider — non-extractability and signature correctness', () => {
  it('produces a signature that actually verifies against the returned public key', async () => {
    const provider = new WebCryptoSecureKeyProvider();
    const publicKey = await provider.generateKey('sign-check');
    const message = new TextEncoder().encode('card protocol test message');
    const signature = await provider.sign('sign-check', message);
    expect(mlDsa44Verify(publicKey, message, signature)).toBe(true);
  });

  it('the wrapping CryptoKey persisted in IndexedDB is non-extractable', async () => {
    const provider = new WebCryptoSecureKeyProvider();
    await provider.generateKey('extractability-check');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('membership-card-protocol-client-sdk');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const record = await new Promise<{ wrappingKey: CryptoKey }>((resolve, reject) => {
      const tx = db.transaction('secure-keys', 'readonly');
      const req = tx.objectStore('secure-keys').get('extractability-check');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(record.wrappingKey.extractable).toBe(false);
  });
});
