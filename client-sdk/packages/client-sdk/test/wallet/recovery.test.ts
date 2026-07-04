import { describe, it, expect, vi } from 'vitest';
import { setupWallet } from '../../src/wallet/setupWallet.js';
import {
  initiateRecovery,
  cancelRecovery,
  releaseRecoveryKey,
  fetchKeyringBlob,
  recoverWallet,
} from '../../src/wallet/recovery.js';
import { decryptKeyring } from '../../src/wallet/keyring.js';
import { deriveDecryptionKey, devicePasskeyOutputFromRegistration } from '../../src/wallet/kdf.js';
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

function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): ObliviousResponse {
  return { status, headers: extraHeaders, body: new TextEncoder().encode(JSON.stringify(body)) };
}

function readJsonBody(options: RequestOptions): Record<string, unknown> {
  if (!options.body) return {};
  return JSON.parse(new TextDecoder().decode(options.body)) as Record<string, unknown>;
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

function makeFakeWalletAppCard(): WalletAppCardIdentity {
  const keypair = mlDsa44GenerateKeypair();
  return {
    cardPointer: 'fake-wallet-app-card-pointer',
    publicKey: keypair.publicKey,
    sign: (message: Uint8Array) => mlDsa44Sign(keypair.secretKey, message),
  };
}

function makeFakeRegisterSubCard(): { fn: RegisterSubCardFn; documents: SignedSubCardDocument[] } {
  const documents: SignedSubCardDocument[] = [];
  const fn: RegisterSubCardFn = vi.fn(async (doc: SignedSubCardDocument) => {
    documents.push(doc);
    return { registered: true };
  });
  return { fn, documents };
}

/** A fake PasskeyProvider whose synced-passkey PRF output is fixed and shared across "devices" — simulating real cross-device synced-passkey behavior. */
function makeFakePasskeyProvider(
  attestationObject: Uint8Array,
  credentialId: Uint8Array,
  syncedPasskeyPrfOutput: Uint8Array
): PasskeyProvider {
  let registerCallCount = 0;
  return {
    register: vi.fn(async (_challenge: Uint8Array) => {
      registerCallCount += 1;
      if (registerCallCount === 1) {
        return { credentialId, attestationObject, clientDataJSON: new TextEncoder().encode('fake-client-data') };
      }
      return {
        credentialId: new TextEncoder().encode(`synced-credential-${registerCallCount}`),
        attestationObject: new TextEncoder().encode(`synced-attestation-${registerCallCount}`),
        clientDataJSON: new TextEncoder().encode('fake-client-data'),
        prfOutput: syncedPasskeyPrfOutput,
      };
    }),
    assert: vi.fn(async () => ({
      credentialId,
      authenticatorData: new TextEncoder().encode('fake-authenticator-data'),
      clientDataJSON: new TextEncoder().encode('fake-client-data'),
      signature: new TextEncoder().encode('fake-signature'),
      prfOutput: syncedPasskeyPrfOutput,
    })),
  };
}

/** A fake PasskeyProvider for a brand-new device during re-registration — device-bound only, no synced-passkey call expected. */
function makeFakeNewDevicePasskeyProvider(attestationObject: Uint8Array, credentialId: Uint8Array): PasskeyProvider {
  return {
    register: vi.fn(async () => ({ credentialId, attestationObject, clientDataJSON: new TextEncoder().encode('x') })),
    assert: vi.fn(),
  };
}

const CAPABILITIES = ['auth_response'];
const NOTIFICATION_CHANNELS: NotificationChannels = { email: 'holder@example.com' };

/**
 * A more complete stub wallet service than `setupWallet.test.ts`'s,
 * additionally implementing backups, recovery initiation/cancellation/
 * release, and keyring-by-id lookup (`plans/wallet-service/implementation-
 * plan.md §Step 3.1-3.5, §Step 4.1a`) — enough to drive the full
 * setup → loss → recovery → re-registration flow end-to-end.
 */
function makeStubWalletService() {
  const state = {
    accounts: new Map<string, { keyringId: string; serviceSecret: Uint8Array }>(),
    keyringBlobsById: new Map<string, string>(),
    backups: new Map<
      string,
      {
        cardHash: string;
        type: string;
        wrappedBlob: string;
        keyringId: string;
        notificationChannels: NotificationChannels;
        cancellationPubkey: string;
      }
    >(),
    recoveryWindows: new Map<string, { backupId: string; status: 'pending' | 'cancelled' | 'released'; releasable: boolean }>(),
    keyringUpdateCalls: 0,
    backupIdCounter: 0,
    recoveryIdCounter: 0,
    challengeCounter: 0,
    subCardDeregistrations: [] as Array<{ baseUrl: string; body: Record<string, unknown> }>,
  };

  /** Test-only shortcut standing in for the real 72-hour wall-clock wait. */
  function forceExpire(recoveryId: string) {
    const window = state.recoveryWindows.get(recoveryId);
    if (window) window.releasable = true;
  }

  const nextChallenge = () => {
    state.challengeCounter += 1;
    return bytesToBase64Url(new TextEncoder().encode(`challenge-${state.challengeCounter}`));
  };

  const transport: ObliviousProtocolTransport = {
    request: vi.fn(async (destination: ObliviousDestination, requestOptions: RequestOptions) => {
      const { method, path } = requestOptions;

      // A stub press (§Step 2.5) — a distinct destination kind sharing
      // this same transport, exactly as recoverWallet's own deregistration
      // step calls it.
      if (destination.kind === 'press') {
        if (method === 'POST' && path === '/sub-card/deregister') {
          const body = readJsonBody(requestOptions);
          state.subCardDeregistrations.push({ baseUrl: destination.baseUrl, body });
          return jsonResponse(200, { tx_hash: `tx-${state.subCardDeregistrations.length}` });
        }
        throw new Error(`stub press: unhandled ${method} ${path}`);
      }

      expect(destination).toEqual({ kind: 'wallet_service' });

      if (method === 'POST' && path === '/accounts/challenge') {
        return jsonResponse(200, { challenge: nextChallenge(), expires_at: new Date(Date.now() + 300_000).toISOString() });
      }

      if (method === 'POST' && path === '/accounts') {
        const body = readJsonBody(requestOptions);
        const cardHash = body.card_hash as string;
        const serviceSecret = crypto.getRandomValues(new Uint8Array(32));
        const keyringId = keccak256(base64UrlToBytes(body.encrypted_keyring_blob as string));
        state.keyringBlobsById.set(keyringId, body.encrypted_keyring_blob as string);
        state.accounts.set(cardHash, { keyringId, serviceSecret });
        return jsonResponse(200, {
          service_secret: bytesToBase64Url(serviceSecret),
          account_id: 'account-1',
          keyring_id: keyringId,
          session_token: 'session-token-1',
          expires_at: new Date(Date.now() + 900_000).toISOString(),
        });
      }

      const keyringChallengeMatch = path.match(/^\/accounts\/([^/]+)\/keyring\/challenge$/);
      if (method === 'POST' && keyringChallengeMatch) {
        return jsonResponse(200, { challenge: nextChallenge(), expires_at: new Date(Date.now() + 300_000).toISOString() });
      }

      const keyringUpdateMatch = path.match(/^\/accounts\/([^/]+)\/keyring$/);
      if (method === 'PUT' && keyringUpdateMatch) {
        const cardHash = keyringUpdateMatch[1]!;
        const body = readJsonBody(requestOptions);
        state.keyringUpdateCalls += 1;
        const newBlob = body.new_encrypted_keyring_blob as string;
        const newKeyringId = keccak256(base64UrlToBytes(newBlob));
        // `rotate_service_secret` (client-sdk Step 2.4 fix, default true):
        // `false` installs the blob without minting a mismatched new
        // secret — see `wallet/recovery.ts`/`setupWallet.ts`'s doc
        // comments and `wallet-service`'s `keyring.put.ts` for why.
        const rotateServiceSecret = body.rotate_service_secret !== false;
        const existingAccount = state.accounts.get(cardHash);
        const serviceSecret = rotateServiceSecret ? crypto.getRandomValues(new Uint8Array(32)) : existingAccount!.serviceSecret;
        state.keyringBlobsById.set(newKeyringId, newBlob);
        state.accounts.set(cardHash, { keyringId: newKeyringId, serviceSecret });
        return jsonResponse(200, { service_secret: bytesToBase64Url(serviceSecret), keyring_id: newKeyringId });
      }

      const backupsMatch = path.match(/^\/accounts\/([^/]+)\/backups$/);
      if (method === 'POST' && backupsMatch) {
        const cardHash = backupsMatch[1]!;
        const body = readJsonBody(requestOptions);
        state.backupIdCounter += 1;
        const backupId = `backup-${state.backupIdCounter}`;
        state.backups.set(backupId, {
          cardHash,
          type: body.type as string,
          wrappedBlob: body.wrapped_blob as string,
          keyringId: body.keyring_id as string,
          notificationChannels: body.notification_channels as NotificationChannels,
          cancellationPubkey: body.cancellation_pubkey as string,
        });
        return jsonResponse(200, { backup_id: backupId });
      }

      const recoveryInitiateMatch = path.match(/^\/accounts\/([^/]+)\/recovery$/);
      if (method === 'POST' && recoveryInitiateMatch) {
        const body = readJsonBody(requestOptions);
        const backupId = body.backup_id as string;
        state.recoveryIdCounter += 1;
        const recoveryId = `recovery-${state.recoveryIdCounter}`;
        state.recoveryWindows.set(recoveryId, { backupId, status: 'pending', releasable: false });
        return jsonResponse(200, {
          recovery_id: recoveryId,
          expires_at: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
          notified_channels: ['email'],
        });
      }

      const cancelMatch = path.match(/^\/recovery\/([^/]+)\/cancel$/);
      if (method === 'POST' && cancelMatch) {
        const recoveryId = cancelMatch[1]!;
        const body = readJsonBody(requestOptions);
        const window = state.recoveryWindows.get(recoveryId);
        if (!window) return jsonResponse(404, { error: 'not found' });
        const backup = state.backups.get(window.backupId)!;

        const challengeText = Buffer.from(body.challenge as string, 'base64url').toString('utf8');
        if (challengeText !== recoveryId) return jsonResponse(401, { error: 'challenge mismatch' });

        const valid = mlDsa44Verify(
          base64UrlToBytes(backup.cancellationPubkey),
          base64UrlToBytes(body.challenge as string),
          base64UrlToBytes(body.signature as string)
        );
        if (!valid) return jsonResponse(401, { error: 'invalid signature' });

        if (window.status === 'released') return jsonResponse(410, { error: 'already released' });
        window.status = 'cancelled';
        return jsonResponse(200, { cancelled: true });
      }

      const releaseMatch = path.match(/^\/recovery\/([^/]+)\/release$/);
      if (method === 'GET' && releaseMatch) {
        const recoveryId = releaseMatch[1]!;
        const window = state.recoveryWindows.get(recoveryId);
        if (!window) return jsonResponse(404, { error: 'not found' });
        if (window.status === 'cancelled') return jsonResponse(410, { error: 'cancelled' });
        if (!window.releasable) return jsonResponse(425, { error: 'too early', retry_after: 259200 });
        window.status = 'released';
        const backup = state.backups.get(window.backupId)!;
        return jsonResponse(200, { wrapped_blob: backup.wrappedBlob, keyring_id: backup.keyringId });
      }

      const keyringGetMatch = path.match(/^\/keyrings\/([^/]+)$/);
      if (method === 'GET' && keyringGetMatch) {
        const keyringId = keyringGetMatch[1]!;
        const blob = state.keyringBlobsById.get(keyringId);
        if (!blob) return jsonResponse(404, { error: 'no replica' });
        return jsonResponse(200, { encrypted_blob: blob });
      }

      throw new Error(`stub wallet service: unhandled ${method} ${path}`);
    }),
  };

  return { transport, state, forceExpire };
}

async function performSetup(overrides?: { yubiKeyProvider?: YubiKeyProvider; yubiKeyPin?: string }) {
  const attestationObject = new TextEncoder().encode('device-bound-attestation');
  const credentialId = new TextEncoder().encode('device-bound-credential');
  const syncedPasskeyPrfOutput = new TextEncoder().encode('fixed-synced-prf-output');

  const passkeyProvider = makeFakePasskeyProvider(attestationObject, credentialId, syncedPasskeyPrfOutput);
  const storageProvider = makeFakeStorageProvider();
  const secureKeyProvider = makeFakeSecureKeyProvider();
  const walletAppCard = makeFakeWalletAppCard();
  const registerSubCard = makeFakeRegisterSubCard();
  const { transport, state, forceExpire } = makeStubWalletService();

  const result = await setupWallet({
    passkeyProvider,
    storageProvider,
    transport,
    secureKeyProvider,
    walletAppCard,
    registerSubCard: registerSubCard.fn,
    capabilities: CAPABILITIES,
    notificationChannels: NOTIFICATION_CHANNELS,
    ...overrides,
  });

  return {
    result,
    transport,
    state,
    forceExpire,
    storageProvider,
    secureKeyProvider,
    walletAppCard,
    registerSubCard,
    syncedPasskeyPrfOutput,
  };
}

describe('recovery (Step 2.4)', () => {
  it('cancellation aborts recovery: release then fails with 410 after a valid cancellation signature', async () => {
    const { result, transport, state } = await performSetup();

    const initiation = await initiateRecovery(transport, result.cardHash, result.syncedPasskeyBackupId);
    expect(initiation.recoveryId).toBeTruthy();
    expect(initiation.notifiedChannels).toEqual(['email']);

    // The legitimate holder still has their original, working device: it
    // can decrypt its own local keyring (using the same reproducible
    // derivation `setupWallet.test.ts`'s first test already relies on) to
    // recover the master key and sign the cancellation.
    const attestationObject = new TextEncoder().encode('device-bound-attestation');
    const devicePasskeyOutput = devicePasskeyOutputFromRegistration(attestationObject);
    const account = state.accounts.get(result.cardHash)!;
    const decryptionKey = deriveDecryptionKey(devicePasskeyOutput, account.serviceSecret);
    const storedBlob = state.keyringBlobsById.get(account.keyringId)!;
    const entries = decryptKeyring(base64UrlToBytes(storedBlob), decryptionKey);
    const masterSecretKey = entries.find((e) => e.cardAddress === result.cardHash)!.privateKey;

    const cancelResult = await cancelRecovery(transport, initiation.recoveryId, masterSecretKey);
    expect(cancelResult.cancelled).toBe(true);

    const releaseOutcome = await releaseRecoveryKey(transport, initiation.recoveryId);
    expect(releaseOutcome.status).toBe('cancelled');
  });

  it('release reports "too_early" before the window has been force-expired, and "released" after', async () => {
    const { result, transport } = await performSetup();
    const initiation = await initiateRecovery(transport, result.cardHash, result.syncedPasskeyBackupId);

    const tooEarly = await releaseRecoveryKey(transport, initiation.recoveryId);
    expect(tooEarly).toEqual({ status: 'too_early', retryAfterSeconds: 259200 });
  });

  it('end-to-end: setup → simulated device loss → recovery initiation → window expiry → key release → keyring fetch from a stub non-primary instance → decrypt → re-registration, with the recovered keyring matching the original bit-for-bit before re-encryption', async () => {
    const { result: originalSetup, transport, state, forceExpire, secureKeyProvider: originalSecureKeyProvider } =
      await performSetup();

    // Simulate device loss: the original device (and its
    // secureKeyProvider/storageProvider) is gone. Only cardHash and the
    // backup id survive, e.g. persisted by the host app outside the lost
    // device's local storage.
    const { cardHash, syncedPasskeyBackupId } = originalSetup;

    const initiation = await initiateRecovery(transport, cardHash, syncedPasskeyBackupId);
    forceExpire(initiation.recoveryId);

    const released = await releaseRecoveryKey(transport, initiation.recoveryId);
    expect(released.status).toBe('released');
    if (released.status !== 'released') throw new Error('unreachable');

    // A stub "non-primary" wallet-service instance: a distinct transport
    // pointed at the same in-memory replica store, proving the fetch isn't
    // implicitly relying on the original instance.
    const nonPrimaryTransport: ObliviousProtocolTransport = {
      request: vi.fn(async (destination, options) => (transport.request as (...args: unknown[]) => unknown)(destination, options) as Promise<ObliviousResponse>),
    };
    const fetchedBlob = await fetchKeyringBlob(nonPrimaryTransport, released.keyringId);

    // New device: a fresh PasskeyProvider whose assert() reproduces the
    // synced passkey's PRF output (cloud-synced credential), and whose
    // register() creates the new device-bound passkey for re-registration.
    const syncedPasskeyPrfOutput = new TextEncoder().encode('fixed-synced-prf-output');
    const newDeviceAttestation = new TextEncoder().encode('new-device-attestation');
    const newDeviceCredentialId = new TextEncoder().encode('new-device-credential');
    const newDevicePasskeyProvider = makeFakePasskeyProvider(
      newDeviceAttestation,
      newDeviceCredentialId,
      syncedPasskeyPrfOutput
    );
    const newDeviceSecureKeyProvider = makeFakeSecureKeyProvider();
    const newDeviceWalletAppCard = makeFakeWalletAppCard();
    const newDeviceRegisterSubCard = makeFakeRegisterSubCard();

    // Decrypt manually first (mirroring what recoverWallet does internally)
    // purely to assert the bit-for-bit match the "Done when" criteria asks
    // for, independent of recoverWallet's own re-encryption.
    const wrappingKeyForAssertion = (await import('../../src/wallet/kdf.js')).syncedPasskeyOutputFromPrf(
      syncedPasskeyPrfOutput
    );
    const { unwrapDecryptionKey } = await import('../../src/wallet/backupRegistration.js');
    const recoveredDecryptionKey = unwrapDecryptionKey(released.wrappedBlob, wrappingKeyForAssertion);
    const recoveredEntriesBeforeReEncryption = decryptKeyring(fetchedBlob, recoveredDecryptionKey);

    const originalAccount = state.accounts.get(cardHash)!;
    const originalDecryptionKey = deriveDecryptionKey(
      devicePasskeyOutputFromRegistration(new TextEncoder().encode('device-bound-attestation')),
      originalAccount.serviceSecret
    );
    // Note: by this point in the real flow the original account's
    // serviceSecret has NOT changed yet (recovery/release never mutate
    // `accounts`), so this is still the correct comparison baseline.
    const originalEntries = decryptKeyring(
      base64UrlToBytes(state.keyringBlobsById.get(originalAccount.keyringId)!),
      originalDecryptionKey
    );
    expect(recoveredEntriesBeforeReEncryption).toEqual(originalEntries);
    expect(recoveredEntriesBeforeReEncryption[0]!.privateKey).toEqual(originalEntries[0]!.privateKey);

    const recovered = await recoverWallet({
      transport,
      storageProvider: makeFakeStorageProvider(),
      secureKeyProvider: newDeviceSecureKeyProvider,
      passkeyProvider: newDevicePasskeyProvider,
      walletAppCard: newDeviceWalletAppCard,
      registerSubCard: newDeviceRegisterSubCard.fn,
      capabilities: CAPABILITIES,
      cardHash,
      method: 'synced_passkey',
      wrappedBlob: released.wrappedBlob,
      keyringId: released.keyringId,
    });

    expect(recovered.cardHash).toBe(cardHash);
    expect(recovered.masterPublicKey).toEqual(originalSetup.masterPublicKey);
    expect(recovered.keyringId).toBeTruthy();
    expect(recovered.keyringId).not.toBe(released.keyringId);
    expect(state.keyringUpdateCalls).toBeGreaterThanOrEqual(2); // provisional + final

    // New device sub-card was generated and registered, under the new
    // device's own (independent) SecureKeyProvider instance — a distinct
    // keypair from the original device's sub-card, even though both use
    // the same default `subCardKeyId` string (which is only a per-provider
    // lookup key, not a globally unique identifier).
    expect(recovered.subCardRegistered).toBe(true);
    expect(newDeviceSecureKeyProvider.keys.has(recovered.subCardKeyId)).toBe(true);
    expect(newDeviceSecureKeyProvider.keys.get(recovered.subCardKeyId)!.publicKey).not.toEqual(
      await originalSecureKeyProvider.getPublicKey(recovered.subCardKeyId)
    );

    // The new authoritative account state decrypts to the same entries the
    // pre-re-encryption snapshot above already confirmed matched bit-for-bit.
    const newAccount = state.accounts.get(cardHash)!;
    const newDevicePasskeyOutput = devicePasskeyOutputFromRegistration(newDeviceAttestation);
    const newDecryptionKey = deriveDecryptionKey(newDevicePasskeyOutput, newAccount.serviceSecret);
    const finalEntries = decryptKeyring(base64UrlToBytes(state.keyringBlobsById.get(newAccount.keyringId)!), newDecryptionKey);
    expect(finalEntries).toEqual(originalEntries);
  });

  it('YubiKey recovery path: unwraps decryption_key using the provider-derived wrapping key', async () => {
    const fixedYubiKeyWrappingKey = new Uint8Array(32).fill(0x66);
    const yubiKeyProvider: YubiKeyProvider = {
      deriveWrappingKey: vi.fn(async (pin: string) => {
        expect(pin).toBe('1234');
        return fixedYubiKeyWrappingKey;
      }),
    };

    const { result: originalSetup, transport, state, forceExpire } = await performSetup({
      yubiKeyProvider,
      yubiKeyPin: '1234',
    });
    expect(originalSetup.yubiKeyBackupId).toBeTruthy();

    const initiation = await initiateRecovery(transport, originalSetup.cardHash, originalSetup.yubiKeyBackupId!);
    forceExpire(initiation.recoveryId);
    const released = await releaseRecoveryKey(transport, initiation.recoveryId);
    expect(released.status).toBe('released');
    if (released.status !== 'released') throw new Error('unreachable');

    const newDeviceAttestation = new TextEncoder().encode('yubikey-recovery-new-device-attestation');
    const newDeviceCredentialId = new TextEncoder().encode('yubikey-recovery-new-device-credential');
    const newDevicePasskeyProvider = makeFakeNewDevicePasskeyProvider(newDeviceAttestation, newDeviceCredentialId);
    const recoveryYubiKeyProvider: YubiKeyProvider = { deriveWrappingKey: vi.fn(async () => fixedYubiKeyWrappingKey) };

    const recovered = await recoverWallet({
      transport,
      storageProvider: makeFakeStorageProvider(),
      secureKeyProvider: makeFakeSecureKeyProvider(),
      passkeyProvider: newDevicePasskeyProvider,
      walletAppCard: makeFakeWalletAppCard(),
      registerSubCard: makeFakeRegisterSubCard().fn,
      capabilities: CAPABILITIES,
      cardHash: originalSetup.cardHash,
      method: 'yubikey',
      wrappedBlob: released.wrappedBlob,
      keyringId: released.keyringId,
      yubiKeyProvider: recoveryYubiKeyProvider,
      yubiKeyPin: '1234',
    });

    expect(recovered.masterPublicKey).toEqual(originalSetup.masterPublicKey);
    expect(recoveryYubiKeyProvider.deriveWrappingKey).toHaveBeenCalledWith('1234');
    expect(state.accounts.get(originalSetup.cardHash)!.keyringId).toBe(recovered.keyringId);
  });

  it('throws if the recovered keyring has no entry for the given card_hash', async () => {
    const { result: originalSetup, transport } = await performSetup();
    await initiateRecovery(transport, originalSetup.cardHash, originalSetup.syncedPasskeyBackupId);

    // Force a mismatched card_hash to exercise the sanity check.
    const wrongCardHash = 'ff'.repeat(20);
    await expect(
      recoverWallet({
        transport,
        storageProvider: makeFakeStorageProvider(),
        secureKeyProvider: makeFakeSecureKeyProvider(),
        passkeyProvider: makeFakePasskeyProvider(
          new TextEncoder().encode('x'),
          new TextEncoder().encode('y'),
          new TextEncoder().encode('fixed-synced-prf-output')
        ),
        walletAppCard: makeFakeWalletAppCard(),
        registerSubCard: makeFakeRegisterSubCard().fn,
        capabilities: CAPABILITIES,
        cardHash: wrongCardHash,
        method: 'synced_passkey',
        wrappedBlob: new Uint8Array(0),
        keyringId: 'nonexistent-keyring-id',
      })
    ).rejects.toThrow();
  });

  describe('post-recovery sub-card deregistration batch (Step 2.5)', () => {
    it('deregisters every previously-active sub-card, signed by the recovered primary key, against each one\'s own stub press', async () => {
      const { result: originalSetup, transport, state, forceExpire } = await performSetup();
      const { cardHash, syncedPasskeyBackupId } = originalSetup;

      const initiation = await initiateRecovery(transport, cardHash, syncedPasskeyBackupId);
      forceExpire(initiation.recoveryId);
      const released = await releaseRecoveryKey(transport, initiation.recoveryId);
      if (released.status !== 'released') throw new Error('unreachable');

      // Two other apps' sub-cards, active before the simulated loss —
      // sourced by the caller (e.g. its own cached card list), per
      // recovery.ts's doc comment on `previouslyActiveSubCards`.
      const appASubCard = mlDsa44GenerateKeypair();
      const appBSubCard = mlDsa44GenerateKeypair();

      const syncedPasskeyPrfOutput = new TextEncoder().encode('fixed-synced-prf-output');
      const newDevicePasskeyProvider = makeFakePasskeyProvider(
        new TextEncoder().encode('step25-new-device-attestation'),
        new TextEncoder().encode('step25-new-device-credential'),
        syncedPasskeyPrfOutput
      );

      const recovered = await recoverWallet({
        transport,
        storageProvider: makeFakeStorageProvider(),
        secureKeyProvider: makeFakeSecureKeyProvider(),
        passkeyProvider: newDevicePasskeyProvider,
        walletAppCard: makeFakeWalletAppCard(),
        registerSubCard: makeFakeRegisterSubCard().fn,
        capabilities: CAPABILITIES,
        cardHash,
        method: 'synced_passkey',
        wrappedBlob: released.wrappedBlob,
        keyringId: released.keyringId,
        previouslyActiveSubCards: [
          { subCardPublicKey: appASubCard.publicKey, press: { baseUrl: 'https://press-a.example' } },
          { subCardPublicKey: appBSubCard.publicKey, press: { baseUrl: 'https://press-b.example' } },
        ],
      });

      expect(recovered.subCardDeregistrations).toHaveLength(2);
      expect(recovered.subCardDeregistrations!.every((o) => o.deregistered)).toBe(true);
      expect(recovered.subCardDeregistrations![0]!.subCardAddress).toBe(keccak256(appASubCard.publicKey));
      expect(recovered.subCardDeregistrations![1]!.subCardAddress).toBe(keccak256(appBSubCard.publicKey));

      // Confirmed against the stub press: each request landed at the
      // correct press, and each signature verifies against the RECOVERED
      // master public key — never a sub-card key.
      expect(state.subCardDeregistrations).toHaveLength(2);
      const [reqA, reqB] = state.subCardDeregistrations;
      expect(reqA!.baseUrl).toBe('https://press-a.example');
      expect(reqB!.baseUrl).toBe('https://press-b.example');

      for (const req of state.subCardDeregistrations) {
        const sigPayload = req.body.sig_payload as { op: string; sub_card_address: string };
        expect(sigPayload.op).toBe('deregister_sub_card');
        const signature = base64UrlToBytes(req.body.master_signature as string);
        expect(mlDsa44Verify(recovered.masterPublicKey, canonicalize(sigPayload), signature)).toBe(true);
      }
    });

    it('omits subCardDeregistrations entirely when no previously-active sub-cards are supplied', async () => {
      const { result: originalSetup, transport, forceExpire } = await performSetup();
      const initiation = await initiateRecovery(transport, originalSetup.cardHash, originalSetup.syncedPasskeyBackupId);
      forceExpire(initiation.recoveryId);
      const released = await releaseRecoveryKey(transport, initiation.recoveryId);
      if (released.status !== 'released') throw new Error('unreachable');

      const recovered = await recoverWallet({
        transport,
        storageProvider: makeFakeStorageProvider(),
        secureKeyProvider: makeFakeSecureKeyProvider(),
        passkeyProvider: makeFakePasskeyProvider(
          new TextEncoder().encode('no-subcards-new-device-attestation'),
          new TextEncoder().encode('no-subcards-new-device-credential'),
          new TextEncoder().encode('fixed-synced-prf-output')
        ),
        walletAppCard: makeFakeWalletAppCard(),
        registerSubCard: makeFakeRegisterSubCard().fn,
        capabilities: CAPABILITIES,
        cardHash: originalSetup.cardHash,
        method: 'synced_passkey',
        wrappedBlob: released.wrappedBlob,
        keyringId: released.keyringId,
      });

      expect(recovered.subCardDeregistrations).toBeUndefined();
    });
  });
});
