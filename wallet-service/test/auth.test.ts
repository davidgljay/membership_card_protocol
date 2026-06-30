import { describe, it, expect } from 'vitest';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { keccak_256 } from '@noble/hashes/sha3';
import {
  issueSessionToken,
  verifySessionToken,
  revokeSessionToken,
  sessionTokenId,
} from '../src/auth/session-token.js';
import { verifyMasterCardSignature, generateChallenge } from '../src/auth/master-card-signature.js';
import { verifyPeerWalletSignature } from '../src/auth/peer-wallet-signature.js';
import type { KvStore } from '../src/kv.js';

function inMemoryKv(): KvStore {
  const store = new Map<string, { value: unknown; expiresAt: number | null }>();
  return {
    async getItem<T>(key: string): Promise<T | null> {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value as T;
    },
    async setItem<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
      store.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
    },
    async removeItem(key: string): Promise<void> {
      store.delete(key);
    },
    async increment(key: string, delta = 1): Promise<number> {
      const current = ((await this.getItem<number>(key)) ?? 0) + delta;
      await this.setItem(key, current);
      return current;
    },
  };
}

const SECRET = 'test-session-secret';

describe('sessionTokenAuth', () => {
  it('accepts a freshly issued, valid token', async () => {
    const kv = inMemoryKv();
    const { token } = issueSessionToken('0xcardhash', SECRET);
    const result = await verifySessionToken(token, SECRET, kv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.card_hash).toBe('0xcardhash');
    }
  });

  it('rejects an expired token', async () => {
    const kv = inMemoryKv();
    const { payload } = issueSessionToken('0xcardhash', SECRET);
    const expiredPayload = { ...payload, expires_at: Date.now() - 1000 };
    const payloadB64 = Buffer.from(JSON.stringify(expiredPayload)).toString('base64url');
    const { createHmac } = await import('node:crypto');
    const sig = createHmac('sha256', SECRET).update(payloadB64).digest('base64url');
    const token = `${payloadB64}.${sig}`;

    const result = await verifySessionToken(token, SECRET, kv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('rejects a tampered token', async () => {
    const kv = inMemoryKv();
    const { token } = issueSessionToken('0xcardhash', SECRET);
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    const result = await verifySessionToken(tampered, SECRET, kv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rejects a revoked token', async () => {
    const kv = inMemoryKv();
    const { token } = issueSessionToken('0xcardhash', SECRET);
    await revokeSessionToken(token, kv);
    const result = await verifySessionToken(token, SECRET, kv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('revoked');
  });

  it('produces a stable, non-reversible session_token_id for audit logging', () => {
    const { token } = issueSessionToken('0xcardhash', SECRET);
    const id1 = sessionTokenId(token);
    const id2 = sessionTokenId(token);
    expect(id1).toBe(id2);
    expect(id1).not.toContain(token);
  });
});

describe('masterCardSignatureAuth', () => {
  it('accepts a valid ML-DSA-44 signature over the challenge', () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const keys = ml_dsa44.keygen(seed);
    const challenge = generateChallenge();
    const signature = ml_dsa44.sign(challenge, keys.secretKey);

    const ok = verifyMasterCardSignature(
      challenge,
      Buffer.from(signature).toString('base64url'),
      Buffer.from(keys.publicKey).toString('base64url')
    );
    expect(ok).toBe(true);
  });

  it('rejects a signature from the wrong key', () => {
    const seedA = crypto.getRandomValues(new Uint8Array(32));
    const seedB = crypto.getRandomValues(new Uint8Array(32));
    const keysA = ml_dsa44.keygen(seedA);
    const keysB = ml_dsa44.keygen(seedB);
    const challenge = generateChallenge();
    const signature = ml_dsa44.sign(challenge, keysA.secretKey);

    const ok = verifyMasterCardSignature(
      challenge,
      Buffer.from(signature).toString('base64url'),
      Buffer.from(keysB.publicKey).toString('base64url')
    );
    expect(ok).toBe(false);
  });

  it('rejects a signature over a different challenge', () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const keys = ml_dsa44.keygen(seed);
    const challenge = generateChallenge();
    const otherChallenge = generateChallenge();
    const signature = ml_dsa44.sign(challenge, keys.secretKey);

    const ok = verifyMasterCardSignature(
      otherChallenge,
      Buffer.from(signature).toString('base64url'),
      Buffer.from(keys.publicKey).toString('base64url')
    );
    expect(ok).toBe(false);
  });
});

describe('peer wallet service signature verification', () => {
  it('accepts a valid signature whose key hashes to the claimed id', () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const keys = ml_dsa44.keygen(seed);
    const message = new TextEncoder().encode('binding-announcement-payload');
    const signature = ml_dsa44.sign(message, keys.secretKey);
    const walletServiceId = '0x' + Buffer.from(keccak_256(keys.publicKey)).toString('hex');

    const ok = verifyPeerWalletSignature(
      message,
      Buffer.from(signature).toString('base64url'),
      Buffer.from(keys.publicKey).toString('base64url'),
      walletServiceId
    );
    expect(ok).toBe(true);
  });

  it('rejects when the claimed wallet_service_id does not match the key', () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const keys = ml_dsa44.keygen(seed);
    const message = new TextEncoder().encode('binding-announcement-payload');
    const signature = ml_dsa44.sign(message, keys.secretKey);

    const ok = verifyPeerWalletSignature(
      message,
      Buffer.from(signature).toString('base64url'),
      Buffer.from(keys.publicKey).toString('base64url'),
      '0xdeadbeef'
    );
    expect(ok).toBe(false);
  });
});
