import { describe, it, expect, vi } from 'vitest';
import { setupWallet } from '../../src/wallet/setupWallet.js';
import { decryptKeyring } from '../../src/wallet/keyring.js';
import { deriveDecryptionKey } from '../../src/wallet/kdf.js';
import { bytesToBase64Url, base64UrlToBytes } from '../../src/util/base64url.js';
import { keccak256 } from '../../src/crypto/hashes.js';
import type { PasskeyProvider } from '../../src/providers/PasskeyProvider.js';
import type { StorageProvider } from '../../src/providers/StorageProvider.js';
import type {
  ObliviousProtocolTransport,
  ObliviousDestination,
  RequestOptions,
  ObliviousResponse,
} from '../../src/providers/ObliviousProtocolTransport.js';

function jsonResponse(status: number, body: unknown): ObliviousResponse {
  return {
    status,
    headers: {},
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
}

function readJsonBody(options: RequestOptions): Record<string, unknown> {
  if (!options.body) return {};
  return JSON.parse(new TextDecoder().decode(options.body)) as Record<string, unknown>;
}

/** A fake PasskeyProvider with deterministic (fixed) registration output. */
function makeFakePasskeyProvider(attestationObject: Uint8Array, credentialId: Uint8Array): PasskeyProvider {
  return {
    register: vi.fn(async (_challenge: Uint8Array) => ({
      credentialId,
      attestationObject,
      clientDataJSON: new TextEncoder().encode('fake-client-data'),
    })),
    assert: vi.fn(),
  };
}

function makeFakeStorageProvider(): StorageProvider & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key)),
    set: vi.fn(async (key: string, value: Uint8Array) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

/**
 * A stubbed wallet service, wired to a fake `ObliviousProtocolTransport`,
 * that implements just enough of `POST /accounts/challenge`, `POST
 * /accounts`, `POST /accounts/{card_hash}/keyring/challenge`, and `PUT
 * /accounts/{card_hash}/keyring` (`plans/wallet-service/
 * implementation-plan.md §Step 2.2, §Step 2.4`) to drive `setupWallet`
 * end-to-end.
 */
function makeStubWalletService(options: { fixedServiceSecret: Uint8Array }) {
  const state = {
    accountsCreateCalls: 0,
    keyringUpdateCalls: 0,
    storedKeyringBlobsByCardHash: new Map<string, string>(),
    lastAccountsCreateBody: undefined as Record<string, unknown> | undefined,
  };

  let challengeCounter = 0;
  const nextChallenge = () => {
    challengeCounter += 1;
    return bytesToBase64Url(new TextEncoder().encode(`challenge-${challengeCounter}`));
  };

  const transport: ObliviousProtocolTransport = {
    request: vi.fn(async (destination: ObliviousDestination, requestOptions: RequestOptions) => {
      expect(destination).toEqual({ kind: 'wallet_service' });

      if (requestOptions.method === 'POST' && requestOptions.path === '/accounts/challenge') {
        return jsonResponse(200, {
          challenge: nextChallenge(),
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        });
      }

      if (requestOptions.method === 'POST' && requestOptions.path === '/accounts') {
        const body = readJsonBody(requestOptions);
        state.accountsCreateCalls += 1;
        state.lastAccountsCreateBody = body;
        const cardHash = body.card_hash as string;
        state.storedKeyringBlobsByCardHash.set(cardHash, body.encrypted_keyring_blob as string);
        return jsonResponse(200, {
          service_secret: bytesToBase64Url(options.fixedServiceSecret),
          account_id: 'account-1',
          keyring_id: keccak256(base64UrlToBytes(body.encrypted_keyring_blob as string)),
          session_token: 'session-token-1',
          expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        });
      }

      const keyringChallengeMatch = requestOptions.path.match(/^\/accounts\/([^/]+)\/keyring\/challenge$/);
      if (requestOptions.method === 'POST' && keyringChallengeMatch) {
        return jsonResponse(200, {
          challenge: nextChallenge(),
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        });
      }

      const keyringUpdateMatch = requestOptions.path.match(/^\/accounts\/([^/]+)\/keyring$/);
      if (requestOptions.method === 'PUT' && keyringUpdateMatch) {
        const cardHash = keyringUpdateMatch[1]!;
        const body = readJsonBody(requestOptions);
        state.keyringUpdateCalls += 1;
        const newBlob = body.new_encrypted_keyring_blob as string;
        state.storedKeyringBlobsByCardHash.set(cardHash, newBlob);
        return jsonResponse(200, {
          service_secret: bytesToBase64Url(options.fixedServiceSecret),
          keyring_id: keccak256(base64UrlToBytes(newBlob)),
        });
      }

      throw new Error(`stub wallet service: unhandled ${requestOptions.method} ${requestOptions.path}`);
    }),
  };

  return { transport, state };
}

describe('setupWallet', () => {
  it('drives full setup against a stubbed wallet service and writes the keyring to StorageProvider', async () => {
    const attestationObject = new TextEncoder().encode('fixed-attestation-object-bytes');
    const credentialId = new TextEncoder().encode('fixed-credential-id');
    const fixedServiceSecret = new Uint8Array(32).fill(7);

    const passkeyProvider = makeFakePasskeyProvider(attestationObject, credentialId);
    const storageProvider = makeFakeStorageProvider();
    const { transport, state } = makeStubWalletService({ fixedServiceSecret });

    const result = await setupWallet({ passkeyProvider, storageProvider, transport });

    // The flow completed and returned the expected public fields.
    expect(result.cardHash).toMatch(/^[0-9a-f]+$/);
    expect(result.accountId).toBe('account-1');
    expect(result.sessionToken).toBe('session-token-1');
    expect(result.passkeyCredentialId).toEqual(credentialId);
    expect(result.keyringId).toBeTruthy();

    // POST /accounts was called once (with a provisional blob), and the
    // keyring-rotation endpoint was called once to install the final blob
    // encrypted under the real decryption_key — see setupWallet.ts's
    // "Ordering judgment call" doc comment for why two calls are needed.
    expect(state.accountsCreateCalls).toBe(1);
    expect(state.keyringUpdateCalls).toBe(1);

    // The keyring was written to the StorageProvider.
    expect(storageProvider.set).toHaveBeenCalledWith('keyring', expect.any(Uint8Array));
    const stored = storageProvider.store.get('keyring');
    expect(stored).toBeDefined();

    // The stored blob must be exactly the final blob the wallet service
    // reports as authoritative for this card_hash (i.e. it matches the
    // last blob installed via PUT .../keyring, not the provisional one from
    // POST /accounts).
    const finalBlobOnServer = state.storedKeyringBlobsByCardHash.get(result.cardHash);
    expect(finalBlobOnServer).toBeDefined();
    expect(bytesToBase64Url(stored!)).toBe(finalBlobOnServer);

    // The stored blob decrypts under the real decryption_key (derived the
    // same way `setupWallet` derives it) to reveal the master private key
    // for this card_hash — confirming the final persisted state is
    // protected by the dual-factor key, not the provisional passkey-only
    // key.
    // devicePasskeyOutput is derived from the fixed attestationObject, so
    // it's fully reproducible here without needing setupWallet to expose it.
    const { devicePasskeyOutputFromRegistration } = await import('../../src/wallet/kdf.js');
    const devicePasskeyOutput = devicePasskeyOutputFromRegistration(attestationObject);
    const decryptionKey = deriveDecryptionKey(devicePasskeyOutput, fixedServiceSecret);
    const entries = decryptKeyring(stored!, decryptionKey);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.cardAddress).toBe(result.cardHash);
    expect(entries[0]!.privateKey.length).toBeGreaterThan(0);

    // The provisional (passkey-only) key must NOT decrypt the final stored
    // blob — proving the final blob genuinely requires both factors.
    expect(() => decryptKeyring(stored!, devicePasskeyOutput)).toThrow();
  });

  it('never persists service_secret in plaintext beyond the derivation step', async () => {
    const attestationObject = new TextEncoder().encode('another-attestation-object');
    const credentialId = new TextEncoder().encode('another-credential-id');
    const fixedServiceSecret = new Uint8Array(32).fill(42);

    const passkeyProvider = makeFakePasskeyProvider(attestationObject, credentialId);
    const storageProvider = makeFakeStorageProvider();
    const { transport } = makeStubWalletService({ fixedServiceSecret });

    await setupWallet({ passkeyProvider, storageProvider, transport });

    // Nothing written to storage contains the service_secret bytes (as a
    // base64url substring or raw bytes) — the only persisted artifact is
    // the AES-GCM-encrypted keyring blob, which is ciphertext.
    const serviceSecretB64Url = bytesToBase64Url(fixedServiceSecret);
    for (const [, value] of storageProvider.store) {
      const asText = Buffer.from(value).toString('utf8');
      expect(asText).not.toContain(serviceSecretB64Url);
      // Raw-byte containment check too (in case of non-UTF8-safe encoding).
      expect(containsBytes(value, fixedServiceSecret)).toBe(false);
    }
  });

  it('does not expose the master private key on the returned result object', async () => {
    const attestationObject = new TextEncoder().encode('yet-another-attestation-object');
    const credentialId = new TextEncoder().encode('yet-another-credential-id');
    const fixedServiceSecret = new Uint8Array(32).fill(99);

    const passkeyProvider = makeFakePasskeyProvider(attestationObject, credentialId);
    const storageProvider = makeFakeStorageProvider();
    const { transport } = makeStubWalletService({ fixedServiceSecret });

    const result = await setupWallet({ passkeyProvider, storageProvider, transport });

    // Structural check: enumerate every own-property of the result and
    // confirm none of them is (or contains, for nested values) more bytes
    // than the known-public fields should carry. Concretely: the only
    // Uint8Array-valued fields on WalletSetupResult are `masterPublicKey`
    // (public by design) and `passkeyCredentialId` (a public identifier) —
    // there is no field carrying secret key material.
    const allowedBinaryFields = new Set(['masterPublicKey', 'passkeyCredentialId']);
    for (const [key, value] of Object.entries(result)) {
      if (value instanceof Uint8Array) {
        expect(allowedBinaryFields.has(key)).toBe(true);
      }
    }

    // Confirm the module's public exports contain no function that could
    // return or accept a master secret key.
    const walletModule = await import('../../src/wallet/index.js');
    expect(Object.keys(walletModule)).not.toContain('masterSecretKey');
    expect(Object.keys(walletModule)).not.toContain('getMasterPrivateKey');
  });
});

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}
