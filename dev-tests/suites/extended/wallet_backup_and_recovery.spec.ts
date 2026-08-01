/**
 * `specs/process_specs/wallet_backup_and_recovery.md` end-to-end, against
 * the live dev deployment. Ported from
 * integration_tests/suites/extended/wallet_backup_and_recovery.spec.ts
 * unchanged in test logic -- this suite was already migrated off
 * client-sdk onto wallet-sdk/app-sdk (see
 * plans/deployment/client-sdk-deprecation-plan.md), so only import sources
 * changed: published `wallet-sdk`/`app-sdk`, `InMemorySecureKeyProvider`
 * from `../../support/keys.js`, and `PRESS_BASE_URL`/
 * `WALLET_SERVICE_BASE_URL`/`RELAY_BASE_URL` from `../../support/liveCard.js`
 * instead of `process.env.SUITE_*`.
 *
 * Covers Process 1 (Initial Wallet Setup), Keyring Storage and Replication,
 * Process 2a (Synced Passkey Recovery), and Process 3 (Post-Recovery
 * Re-registration) using wallet-sdk's real orchestrating functions
 * (`setupWallet`, `registerBackup`, `initiateRecovery`, `cancelRecovery`,
 * `releaseRecoveryKey`, `fetchKeyringBlob`, `recoverWallet`) against the
 * live wallet-service.
 *
 * Rate-limit and environment-limit notes are unchanged from the original
 * suite (see its equivalent comments): this suite shares exactly ONE
 * `setupWallet()`-created account across (almost) every test to stay under
 * account-creation rate limits, and uses a `FakePasskeyProvider` since no
 * real WebAuthn authenticator is available in a headless test run.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  setupWallet,
  recoverWallet,
  initiateRecovery,
  cancelRecovery,
  releaseRecoveryKey,
  fetchKeyringBlob,
  registerBackup,
  wrapDecryptionKey,
  deriveDecryptionKey,
  passkeyOutputFromPrf,
  type WalletSetupResult,
} from '@membership-card-protocol/wallet-sdk';
import {
  HpkeObliviousProtocolTransport,
  mlDsa44GenerateKeypair,
  mlDsa44Sign,
  keccak256,
  bytesToBase64Url,
  base64UrlToBytes,
  canonicalize,
  createCardVerifier,
  type PasskeyProvider,
  type StorageProvider,
  type WalletAppCardIdentity,
  type RegisterSubCardFn,
  type CardVerifier,
  type RpcProvider,
} from '@membership-card-protocol/app-sdk';
import { InMemorySecureKeyProvider } from '../../support/keys.js';
import { PRESS_BASE_URL, WALLET_SERVICE_BASE_URL, RELAY_BASE_URL } from '../../support/liveCard.js';

// --- Test doubles for wallet-sdk's injectable provider interfaces. ---

/**
 * Minimal in-memory `PasskeyProvider`: no real WebAuthn authenticator is
 * available in a headless Node test. Each `register()` call mints a fresh
 * credential with a fresh, random PRF output (deterministic *within* a
 * credential). `assert()` without a `credentialId` resolves to the most
 * recently registered credential.
 */
class FakePasskeyProvider implements PasskeyProvider {
  private credentials: Array<{ credentialId: Uint8Array; prfOutput: Uint8Array }> = [];

  /** Registration order: index 0 is `setupWallet`'s device-bound passkey (Step 2), index 1 is its synced-passkey backup credential (Step 11). */
  credentialAt(index: number): { credentialId: Uint8Array; prfOutput: Uint8Array } {
    const cred = this.credentials[index];
    if (!cred) throw new Error(`FakePasskeyProvider.credentialAt: no credential registered at index ${index}.`);
    return cred;
  }

  async register(_challenge: Uint8Array) {
    const credentialId = crypto.getRandomValues(new Uint8Array(16));
    const prfOutput = crypto.getRandomValues(new Uint8Array(32));
    this.credentials.push({ credentialId, prfOutput });
    return {
      credentialId,
      attestationObject: crypto.getRandomValues(new Uint8Array(64)),
      clientDataJSON: crypto.getRandomValues(new Uint8Array(32)),
      prfOutput,
    };
  }

  async assert(_challenge: Uint8Array, credentialId?: Uint8Array) {
    const cred = credentialId
      ? this.credentials.find((c) => bytesEqual(c.credentialId, credentialId))
      : this.credentials[this.credentials.length - 1];
    if (!cred) {
      throw new Error('FakePasskeyProvider.assert: no matching credential registered.');
    }
    return {
      credentialId: cred.credentialId,
      authenticatorData: crypto.getRandomValues(new Uint8Array(37)),
      clientDataJSON: crypto.getRandomValues(new Uint8Array(32)),
      signature: crypto.getRandomValues(new Uint8Array(64)),
      prfOutput: cred.prfOutput,
    };
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Minimal in-memory `StorageProvider`. */
class InMemoryStorageProvider implements StorageProvider {
  private store = new Map<string, Uint8Array>();
  async get(key: string) {
    return this.store.get(key);
  }
  async set(key: string, value: Uint8Array) {
    this.store.set(key, value);
  }
  async delete(key: string) {
    this.store.delete(key);
  }
}

/**
 * Stub wallet-app identity and on-chain sub-card registration: this suite
 * verifies wallet-service's own endpoints, which never inspect the sub-card
 * document's on-chain registration outcome.
 */
function makeStubWalletAppCard(): WalletAppCardIdentity {
  const keypair = mlDsa44GenerateKeypair();
  return {
    cardPointer: keccak256(keypair.publicKey),
    publicKey: keypair.publicKey,
    sign: (message: Uint8Array) => mlDsa44Sign(keypair.secretKey, message),
  };
}

const stubRegisterSubCard: RegisterSubCardFn = async () => ({ registered: true });

/**
 * A `CardVerifier` that trusts any address it's asked about -- needed only
 * because `setupWallet`/`recoverWallet` validate the wallet's own stub app
 * card through the same pipeline any other app's request would go through.
 */
function makeAlwaysTrustingCardVerifier(): CardVerifier {
  const rpc: RpcProvider = {
    getCardEntry: async () => ({
      log_head_cid: 'cid',
      policy_address: 'policy',
      last_press_address: 'press',
      forward_to: null,
      exists: true,
    }),
    isPolicyAuthorizer: async () => true,
    getPressAuthorization: async () => null,
    getSubCardEntry: async () => null,
    getCardEventLog: async () => [],
    getEasAnnotations: async () => {
      throw new Error('getEasAnnotations should never be called — fetchAnnotations is false');
    },
  };
  return createCardVerifier({
    rpc,
    ipfs: { fetch: async () => { throw new Error('not used — fetchAnnotations is false'); } },
    appCertificationRoot: 'ff'.repeat(32),
    trustedRoots: ['ff'.repeat(32)],
    fetchAnnotations: false,
  });
}

function bypassTransport(): HpkeObliviousProtocolTransport {
  const inner = new HpkeObliviousProtocolTransport({
    relayBaseUrl: RELAY_BASE_URL,
    walletServiceBaseUrl: WALLET_SERVICE_BASE_URL,
  });
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'request') {
        return (
          destination: Parameters<HpkeObliviousProtocolTransport['request']>[0],
          options: Parameters<HpkeObliviousProtocolTransport['request']>[1]
        ) => target.request(destination, { ...options, bypass: true });
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

describe('wallet_backup_and_recovery.md (live dev deployment)', () => {
  let sharedPasskeyProvider: FakePasskeyProvider;
  let sharedSetup: WalletSetupResult<void>;

  beforeAll(async () => {
    const health = await fetch(`${WALLET_SERVICE_BASE_URL}/ohttp/key-config`);
    expect(health.status).toBe(200);

    sharedPasskeyProvider = new FakePasskeyProvider();
    sharedSetup = await setupWallet({
      passkeyProvider: sharedPasskeyProvider,
      storageProvider: new InMemoryStorageProvider(),
      transport: bypassTransport(),
      secureKeyProvider: new InMemorySecureKeyProvider(),
      walletAppCard: makeStubWalletAppCard(),
      registerSubCard: stubRegisterSubCard,
      cardVerifier: makeAlwaysTrustingCardVerifier(),
      capabilities: ['text', 'edit'],
      notificationChannels: { email: `holder-${Date.now()}@example.com` },
    });
  }, 30_000);

  describe('§Process 1: Initial Wallet Setup', () => {
    it('Steps 1-6: two-call service_secret/keyring bootstrap produces a real account, service_secret, and keyring_id', async () => {
      expect(sharedSetup.cardHash).toBeTruthy();
      expect(sharedSetup.accountId).toBeTruthy();
      expect(sharedSetup.keyringId).toBeTruthy();
      expect(sharedSetup.sessionToken).toBeTruthy();
      expect(sharedSetup.expiresAt).toBeTruthy();
      expect(keccak256(sharedSetup.masterPublicKey)).toBe(sharedSetup.cardHash);

      const blob = await fetchKeyringBlob(bypassTransport(), sharedSetup.keyringId);
      expect(blob.length).toBeGreaterThan(0);
    });

    it('Steps 7-10: registers a device sub-card and reports it as registered', async () => {
      expect(sharedSetup.subCardPublicKey.length).toBeGreaterThan(0);
      expect(sharedSetup.subCardKeyId).toBeTruthy();
      expect(sharedSetup.subCardDocument.holder_primary_card).toBe(sharedSetup.cardHash);
      expect(sharedSetup.subCardDocument.app_signature).toBeTruthy();
      expect(sharedSetup.subCardDocument.holder_signature).toBeTruthy();
      expect(sharedSetup.subCardRegistered).toBe(true);
    });

    it('Steps 11-13: registers a synced-passkey backup (default, automatic) with the holder\'s master key as cancellation_pubkey', async () => {
      expect(sharedSetup.syncedPasskeyBackupId).toBeTruthy();
      expect(sharedSetup.yubiKeyBackupId).toBeUndefined();

      const res = await fetch(
        `${WALLET_SERVICE_BASE_URL}/accounts/${sharedSetup.cardHash}/backups/${sharedSetup.syncedPasskeyBackupId}`,
        { headers: { authorization: `Bearer ${sharedSetup.sessionToken}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { type?: string; keyring_id?: string; cancellation_pubkey?: string };
      expect(body.type).toBe('synced_passkey');
      expect(body.keyring_id).toBe(sharedSetup.keyringId);
      expect(body.cancellation_pubkey).toBe(bytesToBase64Url(sharedSetup.masterPublicKey));
    });

    it('Error path: POST /accounts/{card_hash}/backups rejects a registration with no notification channel', async () => {
      const wrappedBlob = wrapDecryptionKey(new Uint8Array(32).fill(0x42), new Uint8Array(32).fill(0x24));
      const res = await fetch(`${WALLET_SERVICE_BASE_URL}/accounts/${sharedSetup.cardHash}/backups`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${sharedSetup.sessionToken}` },
        body: JSON.stringify({
          type: 'yubikey',
          wrapped_blob: bytesToBase64Url(wrappedBlob),
          keyring_id: sharedSetup.keyringId,
          notification_channels: {},
          cancellation_pubkey: bytesToBase64Url(sharedSetup.masterPublicKey),
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { message?: string; statusMessage?: string };
      expect(body.message ?? body.statusMessage).toMatch(/notification channel/i);
    });

    it('Error path: POST /accounts/{card_hash}/backups rejects a request with no bearer token', async () => {
      const res = await fetch(`${WALLET_SERVICE_BASE_URL}/accounts/0xdeadbeef/backups`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'synced_passkey',
          wrapped_blob: 'AAAA',
          keyring_id: 'AAAA',
          notification_channels: { email: 'a@example.com' },
          cancellation_pubkey: 'AAAA',
        }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('§Keyring Storage and Replication', () => {
    it('stores the keyring blob locally, fetchable by any caller via GET /keyrings/{keyring_id} (no auth required — replication read path)', async () => {
      const res = await fetch(`${WALLET_SERVICE_BASE_URL}/keyrings/${sharedSetup.keyringId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { encrypted_blob?: string };
      expect(body.encrypted_blob).toBeTruthy();
    });

    it('Error path: GET /keyrings/{keyring_id} returns 404 for a keyring_id no replica is held for', async () => {
      const res = await fetch(`${WALLET_SERVICE_BASE_URL}/keyrings/0x${'ab'.repeat(32)}`);
      expect(res.status).toBe(404);
    });

    it('§Federation broadcast endpoints: POST /federation/keyrings accepts a validly self-signed replica message', async () => {
      const peerKeypair = mlDsa44GenerateKeypair();
      const peerWalletServiceId = '0x' + keccak256(peerKeypair.publicKey);
      const payload = {
        keyring_id: '0x' + keccak256(new TextEncoder().encode(`fake-blob-${Date.now()}`)),
        card_hash: '0x' + keccak256(mlDsa44GenerateKeypair().publicKey),
        encrypted_blob: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(64))),
      };
      const signature = mlDsa44Sign(peerKeypair.secretKey, canonicalize(payload));
      const message = {
        payload,
        wallet_service_id: peerWalletServiceId,
        public_key: bytesToBase64Url(peerKeypair.publicKey),
        signature: bytesToBase64Url(signature),
      };

      const res = await fetch(`${WALLET_SERVICE_BASE_URL}/federation/keyrings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { stored?: boolean };
      expect(body.stored).toBe(true);

      const fetchRes = await fetch(`${WALLET_SERVICE_BASE_URL}/keyrings/${payload.keyring_id}`);
      expect(fetchRes.status).toBe(200);
    });

    it('Error path: POST /federation/keyrings rejects a message with an invalid signature', async () => {
      const peerKeypair = mlDsa44GenerateKeypair();
      const payload = {
        keyring_id: '0x' + keccak256(new TextEncoder().encode(`bad-blob-${Date.now()}`)),
        card_hash: '0x' + keccak256(mlDsa44GenerateKeypair().publicKey),
        encrypted_blob: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(64))),
      };
      const message = {
        payload,
        wallet_service_id: '0x' + keccak256(peerKeypair.publicKey),
        public_key: bytesToBase64Url(peerKeypair.publicKey),
        signature: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(64))),
      };

      const res = await fetch(`${WALLET_SERVICE_BASE_URL}/federation/keyrings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
      });
      expect(res.status).toBe(401);
    });

    it('§Federation broadcast endpoints: POST /federation/keyrings/delete accepts a validly self-signed delete instruction and the blob becomes unfetchable', async () => {
      const peerKeypair = mlDsa44GenerateKeypair();
      const peerWalletServiceId = '0x' + keccak256(peerKeypair.publicKey);
      const syncPayload = {
        keyring_id: '0x' + keccak256(new TextEncoder().encode(`to-delete-${Date.now()}`)),
        card_hash: '0x' + keccak256(mlDsa44GenerateKeypair().publicKey),
        encrypted_blob: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(64))),
      };
      const syncSignature = mlDsa44Sign(peerKeypair.secretKey, canonicalize(syncPayload));
      const syncRes = await fetch(`${WALLET_SERVICE_BASE_URL}/federation/keyrings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          payload: syncPayload,
          wallet_service_id: peerWalletServiceId,
          public_key: bytesToBase64Url(peerKeypair.publicKey),
          signature: bytesToBase64Url(syncSignature),
        }),
      });
      expect(syncRes.status).toBe(200);

      const deletePayload = { keyring_id: syncPayload.keyring_id };
      const deleteSignature = mlDsa44Sign(peerKeypair.secretKey, canonicalize(deletePayload));
      const deleteRes = await fetch(`${WALLET_SERVICE_BASE_URL}/federation/keyrings/delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          payload: deletePayload,
          wallet_service_id: peerWalletServiceId,
          public_key: bytesToBase64Url(peerKeypair.publicKey),
          signature: bytesToBase64Url(deleteSignature),
        }),
      });
      expect(deleteRes.status).toBe(200);
      const deleteBody = (await deleteRes.json()) as { deleted?: boolean };
      expect(deleteBody.deleted).toBe(true);

      const fetchRes = await fetch(`${WALLET_SERVICE_BASE_URL}/keyrings/${syncPayload.keyring_id}`);
      expect(fetchRes.status).toBe(404);
    });

    it.todo(
      'True cross-instance replication: a second wallet-service instance receives a broadcast and independently ' +
        'serves the replica (requires a second wallet-service instance with PEER_LIST configured)'
    );
  });

  describe('§Process 2a: Synced Passkey Recovery — Initiation and Cancellation Window', () => {
    it('Steps 1-3 + Step 4 ("too early") + idempotency: initiates recovery, reports ~72h/notified_channels, gates release before the window closes, and a second initiation attempt is rejected rather than silently returning the existing window', async () => {
      const before = Date.now();
      const initiation = await initiateRecovery(bypassTransport(), sharedSetup.cardHash, sharedSetup.syncedPasskeyBackupId);

      expect(initiation.recoveryId).toBeTruthy();
      expect(initiation.expiresAt).toBeTruthy();
      const hoursOut = (new Date(initiation.expiresAt).getTime() - before) / (1000 * 60 * 60);
      expect(hoursOut).toBeGreaterThan(71.9);
      expect(hoursOut).toBeLessThan(72.1);
      expect(initiation.notifiedChannels).toContain('email');

      const outcome = await releaseRecoveryKey(bypassTransport(), initiation.recoveryId);
      expect(outcome.status).toBe('too_early');
      if (outcome.status === 'too_early') {
        expect(outcome.retryAfterSeconds).toBeGreaterThan(0);
      }

      await expect(
        initiateRecovery(bypassTransport(), sharedSetup.cardHash, sharedSetup.syncedPasskeyBackupId)
      ).rejects.toThrow(/returned status 409/);
    }, 30_000);

    it('Steps 4-5: a cancellation signed by the registered master card key aborts recovery; a wrong-key attempt is rejected and leaves the window pending', async () => {
      const masterKeypair = mlDsa44GenerateKeypair();
      const backup = await registerBackup({
        transport: bypassTransport(),
        sessionToken: sharedSetup.sessionToken,
        cardHash: sharedSetup.cardHash,
        type: 'yubikey',
        decryptionKey: crypto.getRandomValues(new Uint8Array(32)),
        wrappingKey: crypto.getRandomValues(new Uint8Array(32)),
        keyringId: sharedSetup.keyringId,
        notificationChannels: { email: `holder-cancel-${Date.now()}@example.com` },
        cancellationPubkey: masterKeypair.publicKey,
      });
      const initiation = await initiateRecovery(bypassTransport(), sharedSetup.cardHash, backup.backupId);

      const wrongKeypair = mlDsa44GenerateKeypair();
      await expect(cancelRecovery(bypassTransport(), initiation.recoveryId, wrongKeypair.secretKey)).rejects.toThrow();
      const stillPending = await releaseRecoveryKey(bypassTransport(), initiation.recoveryId);
      expect(stillPending.status).toBe('too_early');

      const cancelResult = await cancelRecovery(bypassTransport(), initiation.recoveryId, masterKeypair.secretKey);
      expect(cancelResult.cancelled).toBe(true);

      const releaseOutcome = await releaseRecoveryKey(bypassTransport(), initiation.recoveryId);
      expect(releaseOutcome.status).toBe('cancelled');
    }, 30_000);

    it('Error path: initiating recovery against an unregistered card_hash returns 404 (no account)', async () => {
      const randomCardHash = '0x' + keccak256(mlDsa44GenerateKeypair().publicKey);
      await expect(initiateRecovery(bypassTransport(), randomCardHash, 'any-backup-id')).rejects.toThrow(
        /returned status 404/
      );
    });

    it.todo(
      'Step 6: key release after the 72-hour window genuinely elapses (requires real wall-clock time — ' +
        'recovery_windows.expires_at is a server-side now() comparison with no fast-forward endpoint)'
    );
  });

  describe('§Process 3: Post-Recovery Re-registration', () => {
    it('Steps 6-12: recovers sharedSetup\'s wallet from a manually-released blob, re-registers with a rotated service_secret/keyring_id, issues a new device sub-card, and batch-deregisters a previously-active sub-card', async () => {
      const deviceCredential = sharedPasskeyProvider.credentialAt(0);
      const syncedCredential = sharedPasskeyProvider.credentialAt(1);
      const devicePasskeyOutput = passkeyOutputFromPrf(deviceCredential.prfOutput);
      const syncedPasskeyOutput = passkeyOutputFromPrf(syncedCredential.prfOutput);
      const serviceSecretRes = await fetch(`${WALLET_SERVICE_BASE_URL}/accounts/${sharedSetup.cardHash}/service-secret`, {
        headers: { authorization: `Bearer ${sharedSetup.sessionToken}` },
      });
      expect(serviceSecretRes.status).toBe(200);
      const { service_secret: serviceSecretB64 } = (await serviceSecretRes.json()) as { service_secret: string };
      const decryptionKey = deriveDecryptionKey(devicePasskeyOutput, base64UrlToBytes(serviceSecretB64));
      const wrappedBlob = wrapDecryptionKey(decryptionKey, syncedPasskeyOutput);

      const lostSecureKeyProvider = new InMemorySecureKeyProvider();
      const lostSubCardPubkey = await lostSecureKeyProvider.generateKey('lost-device-sub-card');
      const expectedSubCardAddress = keccak256(lostSubCardPubkey);

      const recovered = await recoverWallet({
        transport: bypassTransport(),
        storageProvider: new InMemoryStorageProvider(),
        secureKeyProvider: new InMemorySecureKeyProvider(),
        passkeyProvider: sharedPasskeyProvider,
        walletAppCard: makeStubWalletAppCard(),
        registerSubCard: stubRegisterSubCard,
        cardVerifier: makeAlwaysTrustingCardVerifier(),
        capabilities: ['text', 'edit'],
        cardHash: sharedSetup.cardHash,
        method: 'synced_passkey',
        wrappedBlob,
        keyringId: sharedSetup.keyringId,
        previouslyActiveSubCards: [{ subCardPublicKey: lostSubCardPubkey, press: { baseUrl: PRESS_BASE_URL } }],
      });

      expect(recovered.cardHash).toBe(sharedSetup.cardHash);
      expect(bytesToBase64Url(recovered.masterPublicKey)).toBe(bytesToBase64Url(sharedSetup.masterPublicKey));
      expect(recovered.keyringId).not.toBe(sharedSetup.keyringId);
      expect(recovered.subCardRegistered).toBe(true);
      expect(recovered.subCardDocument.holder_primary_card).toBe(sharedSetup.cardHash);
      expect(recovered.subCardDeregistrations).toHaveLength(1);
      expect(recovered.subCardDeregistrations?.[0]?.subCardAddress).toBe(expectedSubCardAddress);

      const oldSessionRes = await fetch(`${WALLET_SERVICE_BASE_URL}/accounts/${sharedSetup.cardHash}/service-secret`, {
        headers: { authorization: `Bearer ${sharedSetup.sessionToken}` },
      });
      expect(oldSessionRes.status).toBe(401);

      const newBlob = await fetchKeyringBlob(bypassTransport(), recovered.keyringId);
      expect(newBlob.length).toBeGreaterThan(0);
    }, 30_000);

    it.todo(
      'Step 13: updates backup registrations under the new decryption_key and revokes the old ones ' +
        '(recoverWallet re-registers the device sub-card and re-installs the keyring, but does not itself ' +
        'call registerBackup again or revoke the prior backup registration — flagged as a real gap, not fixed here)'
    );
  });
});
