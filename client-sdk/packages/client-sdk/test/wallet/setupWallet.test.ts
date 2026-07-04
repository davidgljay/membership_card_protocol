import { describe, it, expect, vi } from 'vitest';
import { setupWallet } from '../../src/wallet/setupWallet.js';
import { decryptKeyring } from '../../src/wallet/keyring.js';
import { deriveDecryptionKey } from '../../src/wallet/kdf.js';
import { unwrapDecryptionKey } from '../../src/wallet/backupRegistration.js';
import type { WalletAppCardIdentity, RegisterSubCardFn, SignedSubCardDocument } from '../../src/wallet/deviceSubCard.js';
import type { NotificationChannels } from '../../src/wallet/backupRegistration.js';
import { bytesToBase64Url, base64UrlToBytes } from '../../src/util/base64url.js';
import { keccak256 } from '../../src/crypto/hashes.js';
import { mlDsa44GenerateKeypair, mlDsa44Sign, mlDsa44Verify } from '../../src/crypto/mldsa.js';
import { canonicalize } from '../../src/crypto/canonicalize.js';
import type { PasskeyProvider } from '../../src/providers/PasskeyProvider.js';
import type { StorageProvider } from '../../src/providers/StorageProvider.js';
import type { SecureKeyProvider } from '../../src/providers/SecureKeyProvider.js';
import type { YubiKeyProvider } from '../../src/providers/YubiKeyProvider.js';
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

/**
 * A fake PasskeyProvider with deterministic registration output. The first
 * `register()` call (the device-bound passkey, Step 2) returns
 * `attestationObject`/`credentialId` exactly as given, so existing tests can
 * recompute `devicePasskeyOutput` independently. Subsequent calls (the
 * synced-passkey backup registration, Step 11) return a distinct-but-still-
 * deterministic attestation, standing in for a genuinely separate credential.
 */
function makeFakePasskeyProvider(attestationObject: Uint8Array, credentialId: Uint8Array): PasskeyProvider {
  let callCount = 0;
  return {
    register: vi.fn(async (_challenge: Uint8Array) => {
      callCount += 1;
      if (callCount === 1) {
        return { credentialId, attestationObject, clientDataJSON: new TextEncoder().encode('fake-client-data') };
      }
      return {
        credentialId: new TextEncoder().encode(`synced-credential-${callCount}`),
        attestationObject: new TextEncoder().encode(`synced-attestation-${callCount}`),
        clientDataJSON: new TextEncoder().encode('fake-client-data'),
      };
    }),
    assert: vi.fn(),
  };
}

const NOTIFICATION_CHANNELS: NotificationChannels = { email: 'holder@example.com' };

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

/** A fake SecureKeyProvider — an in-memory, non-persistent stand-in for the real hardware-backed default implementations. */
function makeFakeSecureKeyProvider(): SecureKeyProvider & {
  keys: Map<string, { publicKey: Uint8Array; secretKey: Uint8Array }>;
} {
  const keys = new Map<string, { publicKey: Uint8Array; secretKey: Uint8Array }>();
  return {
    keys,
    generateKey: vi.fn(async (keyId: string) => {
      const keypair = mlDsa44GenerateKeypair();
      keys.set(keyId, keypair);
      return keypair.publicKey;
    }),
    sign: vi.fn(async (keyId: string, message: Uint8Array) => {
      const keypair = keys.get(keyId);
      if (!keypair) throw new Error(`no key for keyId ${keyId}`);
      return mlDsa44Sign(keypair.secretKey, message);
    }),
    getPublicKey: vi.fn(async (keyId: string) => keys.get(keyId)?.publicKey),
    delete: vi.fn(async (keyId: string) => {
      keys.delete(keyId);
    }),
  };
}

/** A fake wallet app card identity (stands in for the wallet's real, governance-certified app card — see deviceSubCard.ts's doc). */
function makeFakeWalletAppCard(): WalletAppCardIdentity {
  const keypair = mlDsa44GenerateKeypair();
  return {
    cardPointer: 'fake-wallet-app-card-pointer',
    publicKey: keypair.publicKey,
    sign: (message: Uint8Array) => mlDsa44Sign(keypair.secretKey, message),
  };
}

/** A fake test registry standing in for Phase 4's real press-submission flow. */
function makeFakeRegisterSubCard(): { fn: RegisterSubCardFn; documents: SignedSubCardDocument[] } {
  const documents: SignedSubCardDocument[] = [];
  const fn: RegisterSubCardFn = vi.fn(async (doc: SignedSubCardDocument) => {
    documents.push(doc);
    return { registered: true };
  });
  return { fn, documents };
}

const CAPABILITIES = ['auth_response', 'card_offer_accepted'];

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
    backupRegistrations: [] as Array<{ authorization: string | undefined; body: Record<string, unknown> }>,
  };
  let backupIdCounter = 0;

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

      const backupsMatch = requestOptions.path.match(/^\/accounts\/([^/]+)\/backups$/);
      if (requestOptions.method === 'POST' && backupsMatch) {
        const body = readJsonBody(requestOptions);
        backupIdCounter += 1;
        state.backupRegistrations.push({ authorization: requestOptions.headers?.authorization, body });
        return jsonResponse(200, { backup_id: `backup-${backupIdCounter}` });
      }

      throw new Error(`stub wallet service: unhandled ${requestOptions.method} ${requestOptions.path}`);
    }),
  };

  return { transport, state };
}

/** Assembles the common set of fixtures every test below needs. */
function makeFixtures(fixedServiceSecret: Uint8Array, attestationObject: Uint8Array, credentialId: Uint8Array) {
  const passkeyProvider = makeFakePasskeyProvider(attestationObject, credentialId);
  const storageProvider = makeFakeStorageProvider();
  const secureKeyProvider = makeFakeSecureKeyProvider();
  const walletAppCard = makeFakeWalletAppCard();
  const registerSubCard = makeFakeRegisterSubCard();
  const { transport, state } = makeStubWalletService({ fixedServiceSecret });
  return { passkeyProvider, storageProvider, secureKeyProvider, walletAppCard, registerSubCard, transport, state };
}

describe('setupWallet', () => {
  it('drives full setup against a stubbed wallet service and writes the keyring to StorageProvider', async () => {
    const attestationObject = new TextEncoder().encode('fixed-attestation-object-bytes');
    const credentialId = new TextEncoder().encode('fixed-credential-id');
    const fixedServiceSecret = new Uint8Array(32).fill(7);

    const { passkeyProvider, storageProvider, secureKeyProvider, walletAppCard, registerSubCard, transport, state } =
      makeFixtures(fixedServiceSecret, attestationObject, credentialId);

    const result = await setupWallet({
      passkeyProvider,
      storageProvider,
      transport,
      secureKeyProvider,
      walletAppCard,
      registerSubCard: registerSubCard.fn,
      capabilities: CAPABILITIES,
      notificationChannels: NOTIFICATION_CHANNELS,
    });

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

    const { passkeyProvider, storageProvider, secureKeyProvider, walletAppCard, registerSubCard, transport } =
      makeFixtures(fixedServiceSecret, attestationObject, credentialId);

    await setupWallet({
      passkeyProvider,
      storageProvider,
      transport,
      secureKeyProvider,
      walletAppCard,
      registerSubCard: registerSubCard.fn,
      capabilities: CAPABILITIES,
      notificationChannels: NOTIFICATION_CHANNELS,
    });

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

    const { passkeyProvider, storageProvider, secureKeyProvider, walletAppCard, registerSubCard, transport } =
      makeFixtures(fixedServiceSecret, attestationObject, credentialId);

    const result = await setupWallet({
      passkeyProvider,
      storageProvider,
      transport,
      secureKeyProvider,
      walletAppCard,
      registerSubCard: registerSubCard.fn,
      capabilities: CAPABILITIES,
      notificationChannels: NOTIFICATION_CHANNELS,
    });

    // Structural check: enumerate every own-property of the result and
    // confirm none of them is (or contains, for nested values) more bytes
    // than the known-public fields should carry. The only Uint8Array-valued
    // fields on WalletSetupResult are `masterPublicKey`, `passkeyCredentialId`,
    // and `subCardPublicKey` — all public by design — plus `subCardDocument`,
    // a plain object of base64url strings, not raw bytes, so it's excluded
    // from this Uint8Array-specific check entirely (it's covered separately
    // below and by the "no plaintext service_secret" test's shape).
    const allowedBinaryFields = new Set(['masterPublicKey', 'passkeyCredentialId', 'subCardPublicKey']);
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

  describe('device sub-card generation and registration (Step 2.2)', () => {
    it('generates a device sub-card via SecureKeyProvider and registers it against the test registry', async () => {
      const attestationObject = new TextEncoder().encode('sub-card-attestation-object');
      const credentialId = new TextEncoder().encode('sub-card-credential-id');
      const fixedServiceSecret = new Uint8Array(32).fill(11);

      const { passkeyProvider, storageProvider, secureKeyProvider, walletAppCard, registerSubCard, transport } =
        makeFixtures(fixedServiceSecret, attestationObject, credentialId);

      const result = await setupWallet({
        passkeyProvider,
        storageProvider,
        transport,
        secureKeyProvider,
        walletAppCard,
        registerSubCard: registerSubCard.fn,
        capabilities: CAPABILITIES,
        notificationChannels: NOTIFICATION_CHANNELS,
      });

      // A sub-card key was generated under SecureKeyProvider (non-exportable
      // by construction — only sign()/getPublicKey() expose anything about
      // it) and reported back.
      expect(secureKeyProvider.generateKey).toHaveBeenCalledTimes(1);
      expect(result.subCardKeyId).toBeTruthy();
      expect(await secureKeyProvider.getPublicKey(result.subCardKeyId)).toEqual(result.subCardPublicKey);

      // It was submitted to (and accepted by) the test registry exactly once.
      expect(registerSubCard.fn).toHaveBeenCalledTimes(1);
      expect(result.subCardRegistered).toBe(true);
      expect(registerSubCard.documents).toHaveLength(1);
      const doc = registerSubCard.documents[0]!;

      // The document's fields are correctly wired.
      expect(doc.holder_primary_card).toBe(result.cardHash);
      expect(doc.holder_primary_card_pubkey).toBe(bytesToBase64Url(result.masterPublicKey));
      expect(doc.app_card).toBe(walletAppCard.cardPointer);
      expect(doc.app_card_pubkey).toBe(bytesToBase64Url(walletAppCard.publicKey));
      expect(doc.capabilities).toEqual(CAPABILITIES);
      expect(doc.recipient_pubkey).toBe(bytesToBase64Url(result.subCardPublicKey));
      expect(doc.attestation_level).toBe('T1');
      expect(doc).toBe(result.subCardDocument);

      // Both signatures actually verify.
      const { app_signature: appSig, holder_signature: holderSig, ...withoutSignatures } = doc;
      expect(
        mlDsa44Verify(walletAppCard.publicKey, canonicalize(withoutSignatures), base64UrlToBytes(appSig))
      ).toBe(true);
      const withAppSignature = { ...withoutSignatures, app_signature: appSig };
      expect(
        mlDsa44Verify(result.masterPublicKey, canonicalize(withAppSignature), base64UrlToBytes(holderSig))
      ).toBe(true);
    });

    it('routine signing after setup uses the device sub-card key, not the master key', async () => {
      const attestationObject = new TextEncoder().encode('routine-signing-attestation-object');
      const credentialId = new TextEncoder().encode('routine-signing-credential-id');
      const fixedServiceSecret = new Uint8Array(32).fill(13);

      const { passkeyProvider, storageProvider, secureKeyProvider, walletAppCard, registerSubCard, transport } =
        makeFixtures(fixedServiceSecret, attestationObject, credentialId);

      const result = await setupWallet({
        passkeyProvider,
        storageProvider,
        transport,
        secureKeyProvider,
        walletAppCard,
        registerSubCard: registerSubCard.fn,
        capabilities: CAPABILITIES,
        notificationChannels: NOTIFICATION_CHANNELS,
      });

      // A "routine operation" (e.g. signing a message) after setup goes
      // through secureKeyProvider.sign(subCardKeyId, ...) — the only key
      // material this test's harness has any access to at all, since the
      // master key was cleared inside setupWallet before returning
      // (already proven by the "does not expose the master private key"
      // test above; this test is about which key routine signing *uses*,
      // not just which key is hidden).
      const message = new TextEncoder().encode('routine operation payload');
      const signature = await secureKeyProvider.sign(result.subCardKeyId, message);
      expect(mlDsa44Verify(result.subCardPublicKey, message, signature)).toBe(true);

      // Exactly one key was ever generated via SecureKeyProvider (the
      // device sub-card) — no other signing key exists for "routine
      // operations" to have used instead.
      expect(secureKeyProvider.keys.size).toBe(1);
      expect(secureKeyProvider.keys.has(result.subCardKeyId)).toBe(true);
    });
  });

  describe('backup registration (Step 2.3)', () => {
    it('always registers a synced-passkey backup, Bearer-authenticated, whose wrapped blob unwraps to decryption_key', async () => {
      const attestationObject = new TextEncoder().encode('backup-attestation-object');
      const credentialId = new TextEncoder().encode('backup-credential-id');
      const fixedServiceSecret = new Uint8Array(32).fill(21);

      const { passkeyProvider, storageProvider, secureKeyProvider, walletAppCard, registerSubCard, transport, state } =
        makeFixtures(fixedServiceSecret, attestationObject, credentialId);

      const result = await setupWallet({
        passkeyProvider,
        storageProvider,
        transport,
        secureKeyProvider,
        walletAppCard,
        registerSubCard: registerSubCard.fn,
        capabilities: CAPABILITIES,
        notificationChannels: NOTIFICATION_CHANNELS,
      });

      // register() was called twice: once for the device-bound passkey
      // (Step 2), once for the synced-passkey backup (Step 11).
      expect(passkeyProvider.register).toHaveBeenCalledTimes(2);

      expect(result.syncedPasskeyBackupId).toBeTruthy();
      expect(result.yubiKeyBackupId).toBeUndefined();

      expect(state.backupRegistrations).toHaveLength(1);
      const registration = state.backupRegistrations[0]!;
      expect(registration.authorization).toBe(`Bearer ${result.sessionToken}`);
      expect(registration.body.type).toBe('synced_passkey');
      expect(registration.body.keyring_id).toBe(result.keyringId);
      expect(registration.body.notification_channels).toEqual(NOTIFICATION_CHANNELS);
      expect(registration.body.cancellation_pubkey).toBe(bytesToBase64Url(result.masterPublicKey));

      // The wallet service never sees decryption_key: the wire body's
      // wrapped_blob is opaque ciphertext, distinct from decryption_key's
      // own bytes.
      const decryptionKey = deriveDecryptionKey(
        (await import('../../src/wallet/kdf.js')).devicePasskeyOutputFromRegistration(attestationObject),
        fixedServiceSecret
      );
      const wrappedBlob = base64UrlToBytes(registration.body.wrapped_blob as string);
      expect(containsBytes(wrappedBlob, decryptionKey)).toBe(false);

      // But it unwraps back to decryption_key using the synced-passkey
      // output the fake PasskeyProvider's second register() call produced —
      // proving the round trip is genuinely reproducible, not coincidental.
      const syncedPasskeyOutput = (await import('../../src/wallet/kdf.js')).devicePasskeyOutputFromRegistration(
        new TextEncoder().encode('synced-attestation-2')
      );
      const unwrapped = unwrapDecryptionKey(wrappedBlob, syncedPasskeyOutput);
      expect(unwrapped).toEqual(decryptionKey);
    });

    it('additionally registers a YubiKey backup when a YubiKeyProvider is supplied, requiring a PIN', async () => {
      const attestationObject = new TextEncoder().encode('yubikey-attestation-object');
      const credentialId = new TextEncoder().encode('yubikey-credential-id');
      const fixedServiceSecret = new Uint8Array(32).fill(33);

      const { passkeyProvider, storageProvider, secureKeyProvider, walletAppCard, registerSubCard, transport, state } =
        makeFixtures(fixedServiceSecret, attestationObject, credentialId);

      const fixedWrappingKey = new Uint8Array(32).fill(55);
      const yubiKeyProvider: YubiKeyProvider = {
        deriveWrappingKey: vi.fn(async (pin: string) => {
          expect(pin).toBe('1234');
          return fixedWrappingKey;
        }),
      };

      const result = await setupWallet({
        passkeyProvider,
        storageProvider,
        transport,
        secureKeyProvider,
        walletAppCard,
        registerSubCard: registerSubCard.fn,
        capabilities: CAPABILITIES,
        notificationChannels: NOTIFICATION_CHANNELS,
        yubiKeyProvider,
        yubiKeyPin: '1234',
      });

      expect(yubiKeyProvider.deriveWrappingKey).toHaveBeenCalledTimes(1);
      expect(result.yubiKeyBackupId).toBeTruthy();
      expect(state.backupRegistrations).toHaveLength(2);

      const yubiKeyRegistration = state.backupRegistrations.find((r) => r.body.type === 'yubikey');
      expect(yubiKeyRegistration).toBeDefined();
      expect(yubiKeyRegistration!.authorization).toBe(`Bearer ${result.sessionToken}`);

      const decryptionKey = deriveDecryptionKey(
        (await import('../../src/wallet/kdf.js')).devicePasskeyOutputFromRegistration(attestationObject),
        fixedServiceSecret
      );
      const wrappedBlob = base64UrlToBytes(yubiKeyRegistration!.body.wrapped_blob as string);
      const unwrapped = unwrapDecryptionKey(wrappedBlob, fixedWrappingKey);
      expect(unwrapped).toEqual(decryptionKey);
    });

    it('throws if a YubiKeyProvider is supplied without a PIN', async () => {
      const attestationObject = new TextEncoder().encode('yubikey-no-pin-attestation-object');
      const credentialId = new TextEncoder().encode('yubikey-no-pin-credential-id');
      const fixedServiceSecret = new Uint8Array(32).fill(44);

      const { passkeyProvider, storageProvider, secureKeyProvider, walletAppCard, registerSubCard, transport } =
        makeFixtures(fixedServiceSecret, attestationObject, credentialId);

      const yubiKeyProvider: YubiKeyProvider = { deriveWrappingKey: vi.fn(async () => new Uint8Array(32)) };

      await expect(
        setupWallet({
          passkeyProvider,
          storageProvider,
          transport,
          secureKeyProvider,
          walletAppCard,
          registerSubCard: registerSubCard.fn,
          capabilities: CAPABILITIES,
          notificationChannels: NOTIFICATION_CHANNELS,
          yubiKeyProvider,
        })
      ).rejects.toThrow(/yubiKeyPin is required/);
    });
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
