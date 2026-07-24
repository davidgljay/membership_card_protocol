/**
 * `specs/process_specs/wallet_backup_and_recovery.md` end-to-end — Phase 5
 * Wave 3.
 *
 * Covers:
 *   § Process 1 (Initial Wallet Setup): the real two-call service_secret/
 *     keyring bootstrap sequence (`wallet.md §7.2-7.3`), decryption_key
 *     derivation, device sub-card issuance, and synced-passkey backup
 *     registration (Steps 1-13).
 *   § Keyring Storage and Replication: local storage/retrieval of the
 *     encrypted keyring blob by `keyring_id`, and the peer-facing
 *     `/federation/keyrings*` endpoints' own signature verification.
 *   § Process 2a (Synced Passkey Recovery): initiation, multi-channel
 *     notification, the 72-hour cancellation window's "too early" (425)
 *     state, and cancellation via the master card key.
 *   § Process 3 (Post-Recovery Re-registration): full recovery — unwrap,
 *     fetch, decrypt, re-register with a rotated service_secret/keyring_id,
 *     new device sub-card, and post-recovery sub-card deregistration.
 *
 * This suite uses `@membership-card-protocol/client-sdk`'s real
 * orchestrating functions (`setupWallet`, `registerBackup`,
 * `initiateRecovery`, `cancelRecovery`, `releaseRecoveryKey`,
 * `fetchKeyringBlob`, `recoverWallet`) against the live wallet-service —
 * not hand-rolled HTTP calls — via `app-sdk`'s real
 * `HpkeObliviousProtocolTransport` with `bypass: true` (a direct HTTPS
 * call to `${baseUrl}${path}`; unlike press, wallet-service's real HTTP
 * routes already live at the bare, unprefixed paths this suite's sibling
 * suites (`message_routing.spec.ts`, `card_migration.spec.ts`) call
 * directly with plain `fetch` — so `bypass: true` here has no analogue to
 * `oblivious_transport.spec.ts`'s documented `/issue` vs `/api/issue`
 * mismatch).
 *
 * `PasskeyProvider` (WebAuthn) has no real authenticator available in a
 * headless Node test — this suite supplies a minimal, deterministic
 * in-memory fake (`FakePasskeyProvider` below) satisfying the interface's
 * contract: `register()` returns a fresh credential with a fresh PRF
 * output; `assert()` without a `credentialId` resolves to the most
 * recently registered credential (mirroring "the synced passkey is the
 * only credential registered for this purpose at this origin", per
 * `recovery.ts`'s own doc comment on `PasskeyProvider.assert()`), which is
 * correct for this suite's flow since `setupWallet` registers the device
 * passkey first and the synced-passkey backup second — the synced
 * credential is always the fake's "most recent" by the time recovery
 * asserts against it.
 *
 * **Rate limits, confirmed against the actual code — this drove this
 * suite's structure more than anything else**:
 *   - `POST /accounts` (account creation) is capped at 5 per hashed-IP per
 *     hour (`wallet-service/src/routes/accounts-create.ts`'s
 *     `ACCOUNT_CREATION_RATE_LIMIT`/`_WINDOW_SECONDS`), and `POST
 *     /accounts/challenge` shares the same limit. Every test in this file
 *     therefore shares exactly ONE `setupWallet()`-created account
 *     (`sharedSetup`, built once in `beforeAll`) rather than minting a
 *     fresh one per test — an earlier draft of this suite called
 *     `setupWallet()` once per test and consistently hit 429 by the
 *     fourth or fifth call, confirmed live. `describe` blocks are ordered
 *     so the one test that mutates `sharedSetup`'s keyring/service_secret
 *     (§Process 3's real `recoverWallet` call) runs last.
 *   - `POST /accounts/{card_hash}/recovery` (recovery initiation) is
 *     separately capped at 3 per `card_hash` per 24 hours
 *     (`wallet-service/server/routes/accounts/[card_hash]/recovery.post.ts`'s
 *     `RECOVERY_RATE_LIMIT`/`_WINDOW_SECONDS` — checked before the
 *     backup/account lookup, so even a request that 404s later still
 *     consumes the budget). §Process 2a below uses exactly 3 initiation
 *     calls against `sharedSetup.cardHash` total; the "unknown card_hash"
 *     error-path test below deliberately uses a throwaway random
 *     `card_hash` instead, so it doesn't compete for that budget.
 *
 * **Other environment limits, confirmed against the actual code, not
 * assumed**:
 *   - This stack runs exactly ONE wallet-service instance (`PEER_LIST=[]`
 *     in `env/wallet-service/.dev.vars`) — genuine cross-service keyring
 *     *replication* (a second instance receiving `/federation/keyrings`
 *     from the primary and being fetchable independently) is out of reach.
 *     `announceOwnCardRegistration`/`replicateKeyringBlob`
 *     (`wallet-service/server/utils/federation-self.ts`) still execute
 *     during setup/rotation (their `PEER_LIST.map` is just a no-op over an
 *     empty list), so local storage/retrieval of the keyring blob by
 *     `keyring_id` — the property recovery actually depends on — is fully
 *     exercised. The receiving side of `/federation/keyrings` and
 *     `/federation/keyrings/delete` (signature verification) is tested
 *     directly, self-signed, the same pattern `card_migration.spec.ts`
 *     uses for `/bindings/announce`.
 *   - The 72-hour cancellation window is a persisted `expires_at` column
 *     compared against server-side `now()`
 *     (`wallet-service/server/db/recovery.ts`'s own doc comment: "never an
 *     in-process timer... every check here is a comparison against
 *     server-side now(), never client-supplied time") — there is no
 *     admin/test endpoint to fast-forward it, so this suite cannot observe
 *     the window's *expiry* (key release after 72h) for real. It exercises
 *     everything reachable without waiting: initiation, notification
 *     fan-out, the "too early" 425 immediately after initiation, and the
 *     cancellation path (Process 2a Steps 4-5), which needs no time to
 *     elapse. Actual key release (Step 6) is `it.todo`.
 *   - `registerSubCard`/`walletAppCard` (client-sdk's injection points for
 *     Step 9's "posted on Arbitrum One") are stubbed in this suite: the
 *     spec's own annotation on `RegisterSubCardFn` (`deviceSubCard.ts`)
 *     frames on-chain sub-card registration as "Phase 4 Step 4.4's
 *     press-submission flow... stands in for" — a deliberate SDK injection
 *     seam, not something wallet-service itself performs. On-chain
 *     sub-card registration mechanics are covered elsewhere
 *     (`subcard_creation_policy.spec.ts`); this suite verifies
 *     wallet-service's own account/keyring/backup/recovery endpoints,
 *     which never look at the sub-card's chain-registration outcome.
 *
 * Requires the `integration_tests` stack up (`docker compose up -d --wait
 * wallet-service relay redis`).
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
  type PasskeyProvider,
  type StorageProvider,
  type WalletAppCardIdentity,
  type RegisterSubCardFn,
  type WalletSetupResult,
} from '@membership-card-protocol/client-sdk';
import {
  HpkeObliviousProtocolTransport,
  mlDsa44GenerateKeypair,
  mlDsa44Sign,
  keccak256,
  bytesToBase64Url,
  base64UrlToBytes,
  canonicalize,
} from '@membership-card-protocol/app-sdk';
import { InMemorySecureKeyProvider } from '@membership-card-protocol/integration-fixtures';
import { PRESS_BASE_URL } from '../support/liveCard.js';

const WALLET_SERVICE_BASE_URL = (process.env.SUITE_WALLET_SERVICE_URL ?? 'http://localhost:3002').replace(/\/$/, '');
const RELAY_BASE_URL = (process.env.SUITE_RELAY_URL ?? 'http://localhost:3000').replace(/\/$/, '');

// --- Test doubles for client-sdk's injectable provider interfaces. ---

/**
 * Minimal in-memory `PasskeyProvider`: no real WebAuthn authenticator is
 * available in a headless Node test. Each `register()` call mints a fresh
 * credential with a fresh, random PRF output (deterministic *within* a
 * credential, since the same stored value is returned every time that
 * credential is asserted against — the property `recovery.ts` actually
 * depends on for the synced-passkey path). `assert()` without a
 * `credentialId` resolves to the most recently registered credential.
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
 * document's on-chain registration outcome (see the file-level doc comment
 * for why real on-chain registration is out of scope here).
 */
function makeStubWalletAppCard(): WalletAppCardIdentity {
  const keypair = mlDsa44GenerateKeypair();
  return {
    cardPointer: 'stub-wallet-app-card',
    publicKey: keypair.publicKey,
    sign: (message: Uint8Array) => mlDsa44Sign(keypair.secretKey, message),
  };
}

const stubRegisterSubCard: RegisterSubCardFn = async () => ({ registered: true });

// bypass:true is applied uniformly by wrapping the transport's `request` —
// client-sdk's functions don't expose a `bypass` option of their own, so
// this thin wrapper injects it on every call, matching
// `oblivious_transport.spec.ts`'s confirmed-safe direct-HTTPS mode for
// wallet-service (no path-prefix mismatch there, unlike press's `/api/*`).
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

describe('wallet_backup_and_recovery.md (live stack)', () => {
  // Shared across (almost) every test in this file — see the rate-limit
  // note in the file-level doc comment for why this suite deliberately
  // creates exactly one account rather than one per test.
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

      // Postcondition: the wallet service actually stored the final blob
      // under the keyring_id setupWallet reports — fetchable by the same
      // GET /keyrings/{keyring_id} recovery uses (§Keyring Storage and
      // Replication: "may fetch the keyring blob by keyring_id from any
      // reachable wallet service holding a replica").
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

      // Postcondition: GET .../backups/{backup_id} confirms the backup
      // service (same wallet-service instance) actually stored it, with
      // the wire-shape fields Step 13 describes — wrapped_blob itself is
      // deliberately excluded from this read path (server never
      // re-discloses it outside registration/release).
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
      // Acting as a peer wallet service submitting a replica to this
      // instance — same "self-signed, single-instance" pattern
      // card_migration.spec.ts uses for /bindings/announce, since a real
      // second peer instance is out of reach in this environment (see
      // file-level doc comment).
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

      // Confirm it's now fetchable — proves this instance genuinely stored
      // the peer-submitted replica, not just accepted the envelope.
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
        signature: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(64))), // garbage signature
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
        'serves the replica (requires a second wallet-service instance with PEER_LIST configured — this stack ' +
        'runs exactly one instance, env/wallet-service/.dev.vars PEER_LIST=[])'
    );
  });

  describe('§Process 2a: Synced Passkey Recovery — Initiation and Cancellation Window', () => {
    // Both tests below together make exactly 3 calls to
    // POST /accounts/{card_hash}/recovery against sharedSetup.cardHash —
    // this account's entire 24-hour recovery-initiation budget (see the
    // file-level doc comment). Order matters: this describe block must run
    // before §Process 3 mutates sharedSetup's keyring/service_secret (it
    // doesn't touch recovery windows, so ordering here is about budget
    // bookkeeping, not correctness).

    it('Steps 1-3 + Step 4 ("too early") + idempotency: initiates recovery, reports ~72h/notified_channels, gates release before the window closes, and a second initiation attempt is rejected rather than silently returning the existing window', async () => {
      const before = Date.now();
      const initiation = await initiateRecovery(bypassTransport(), sharedSetup.cardHash, sharedSetup.syncedPasskeyBackupId);

      expect(initiation.recoveryId).toBeTruthy();
      expect(initiation.expiresAt).toBeTruthy();
      const hoursOut = (new Date(initiation.expiresAt).getTime() - before) / (1000 * 60 * 60);
      expect(hoursOut).toBeGreaterThan(71.9);
      expect(hoursOut).toBeLessThan(72.1);
      expect(initiation.notifiedChannels).toContain('email');

      // Step 4: well before 72h, release is gated.
      const outcome = await releaseRecoveryKey(bypassTransport(), initiation.recoveryId);
      expect(outcome.status).toBe('too_early');
      if (outcome.status === 'too_early') {
        expect(outcome.retryAfterSeconds).toBeGreaterThan(0);
      }

      // BUG, confirmed live: the wallet-service route
      // (accounts/[card_hash]/recovery.post.ts) treats a second initiation
      // against an already-pending backup as idempotent — it returns
      // HTTP 409 with { recovery_id, expires_at } of the *existing* window,
      // not an error. But client-sdk's `initiateRecovery` (wallet/
      // recovery.ts) calls the shared `requestJson` helper, which throws
      // on *any* non-2xx status and discards the response body — so the
      // server's idempotent 409 response is indistinguishable, from this
      // SDK function's perspective, from a genuine failure. A caller has
      // no way to recover the existing recovery_id from this call the way
      // the server intends. Not fixed here (out of a test-writing pass's
      // scope) — demonstrated below and flagged in this suite's report.
      await expect(
        initiateRecovery(bypassTransport(), sharedSetup.cardHash, sharedSetup.syncedPasskeyBackupId)
      ).rejects.toThrow(/returned status 409/);
    }, 30_000);

    it('Steps 4-5: a cancellation signed by the registered master card key aborts recovery; a wrong-key attempt is rejected and leaves the window pending', async () => {
      // A second, independent backup on the same account (registerBackup
      // is not rate-limited the way account creation/recovery-initiation
      // are), with a cancellation_pubkey this test directly controls the
      // secret key for — the "legitimate holder's device/master key is
      // still intact" threat model Process 2a's Security notes describe.
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

      // Error path: wrong key rejected, window still pending.
      const wrongKeypair = mlDsa44GenerateKeypair();
      await expect(cancelRecovery(bypassTransport(), initiation.recoveryId, wrongKeypair.secretKey)).rejects.toThrow();
      const stillPending = await releaseRecoveryKey(bypassTransport(), initiation.recoveryId);
      expect(stillPending.status).toBe('too_early');

      // Correct key cancels.
      const cancelResult = await cancelRecovery(bypassTransport(), initiation.recoveryId, masterKeypair.secretKey);
      expect(cancelResult.cancelled).toBe(true);

      // Postcondition (Step 5): release afterward is 'cancelled', never a
      // key release, regardless of how much of the window has elapsed.
      const releaseOutcome = await releaseRecoveryKey(bypassTransport(), initiation.recoveryId);
      expect(releaseOutcome.status).toBe('cancelled');
    }, 30_000);

    it('Error path: initiating recovery against an unregistered card_hash returns 404 (no account)', async () => {
      // A random, never-set-up card_hash — a distinct rate-limit bucket
      // from sharedSetup.cardHash, so this doesn't compete for that
      // account's 3-per-24h recovery-initiation budget.
      const randomCardHash = '0x' + keccak256(mlDsa44GenerateKeypair().publicKey);
      await expect(initiateRecovery(bypassTransport(), randomCardHash, 'any-backup-id')).rejects.toThrow(
        /returned status 404/
      );
    });

    it.todo(
      'Step 6: key release after the 72-hour window genuinely elapses (requires real wall-clock time — ' +
        'recovery_windows.expires_at is a server-side now() comparison with no fast-forward endpoint, ' +
        'per wallet-service/server/db/recovery.ts\'s own doc comment)'
    );
  });

  describe('§Process 3: Post-Recovery Re-registration', () => {
    it('Steps 6-12: recovers sharedSetup\'s wallet from a manually-released blob, re-registers with a rotated service_secret/keyring_id, issues a new device sub-card, and batch-deregisters a previously-active sub-card', async () => {
      // recoverWallet (client-sdk) takes an *already-released* wrappedBlob
      // + keyringId (its own doc: "polling releaseRecoveryKey beforehand
      // is the caller's concern"). Since this environment cannot make the
      // 72-hour window genuinely elapse (see file-level doc comment), and
      // since real release/cancel mechanics are already covered directly
      // in §Process 2a above, this test constructs the post-release state
      // directly: it independently re-derives the same decryption_key
      // setupWallet used for the synced-passkey backup (assert() against
      // the fake's most-recently-registered credential — the synced one —
      // and GET .../service-secret with sharedSetup's still-live session
      // token), wraps it the same way, and calls recoverWallet with that
      // wrapped blob — exercising every one of recoverWallet's own steps
      // (unwrap, fetch, decrypt, deregister, re-register, new device
      // sub-card) against the real wallet service.
      //
      // This is the one test in this file that mutates sharedSetup's
      // account state (rotates service_secret/keyring_id and invalidates
      // its session token) — it must run last within this file, hence
      // §Process 3 is the final describe block.
      //
      // decryption_key = KDF(device_passkey_output, service_secret) is
      // derived from the DEVICE-BOUND passkey (setupWallet's Step 2,
      // credential index 0) — NOT the synced-passkey backup credential
      // (Step 11, index 1). The synced-passkey backup only WRAPS this same
      // decryption_key under the synced credential's own output; it does
      // not re-derive it. Using the wrong credential here reproduces a
      // real bug this suite hit while writing it: recoverWallet's
      // `decryptKeyring` fails with "aes/gcm: invalid ghash tag" if the
      // reconstructed decryption_key doesn't match the one the keyring was
      // actually encrypted under.
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

      // A sub-card "active before the loss" (Step 12) — supplied by the
      // caller, per recoverWallet's own doc ("neither the recovered
      // keyring nor anything else this SDK persists tracks sub-card
      // issuance"). It was never actually registered on press in this
      // test, so the batch deregistration call against press is expected
      // to report a failure outcome for it — this verifies recoverWallet
      // drives the batch deregistration step at all, signed by the
      // just-recovered master key, and reports one outcome per supplied
      // sub-card, regardless of whether press accepts it.
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
        capabilities: ['text', 'edit'],
        cardHash: sharedSetup.cardHash,
        method: 'synced_passkey',
        wrappedBlob,
        keyringId: sharedSetup.keyringId,
        previouslyActiveSubCards: [{ subCardPublicKey: lostSubCardPubkey, press: { baseUrl: PRESS_BASE_URL } }],
      });

      // Postconditions (§Postconditions): accessible from the "new
      // device", dual-factor model restored with a rotated
      // service_secret/keyring_id, compromised sub-card deregistration
      // attempted.
      expect(recovered.cardHash).toBe(sharedSetup.cardHash);
      expect(bytesToBase64Url(recovered.masterPublicKey)).toBe(bytesToBase64Url(sharedSetup.masterPublicKey));
      expect(recovered.keyringId).not.toBe(sharedSetup.keyringId);
      expect(recovered.subCardRegistered).toBe(true);
      expect(recovered.subCardDocument.holder_primary_card).toBe(sharedSetup.cardHash);
      expect(recovered.subCardDeregistrations).toHaveLength(1);
      expect(recovered.subCardDeregistrations?.[0]?.subCardAddress).toBe(expectedSubCardAddress);

      // Confirm rotate_service_secret: true actually invalidated the old
      // session token (Process 3 Step 10: "invalidating every session
      // token previously issued for this card_hash").
      const oldSessionRes = await fetch(`${WALLET_SERVICE_BASE_URL}/accounts/${sharedSetup.cardHash}/service-secret`, {
        headers: { authorization: `Bearer ${sharedSetup.sessionToken}` },
      });
      expect(oldSessionRes.status).toBe(401);

      // The new keyring_id is fetchable (post-recovery re-registration
      // re-broadcasts/stores it locally, same as initial setup).
      const newBlob = await fetchKeyringBlob(bypassTransport(), recovered.keyringId);
      expect(newBlob.length).toBeGreaterThan(0);
    }, 30_000);

    it.todo(
      'Step 13: updates backup registrations under the new decryption_key and revokes the old ones ' +
        '(recoverWallet re-registers the device sub-card and re-installs the keyring, but does not itself ' +
        'call registerBackup again or revoke the prior backup registration — this appears to be a real gap: ' +
        'the spec\'s Postconditions state "Backup registration(s) are updated under the new decryption key," ' +
        'but neither client-sdk\'s recoverWallet nor any wallet-service endpoint this suite found performs ' +
        'that update/revocation automatically. Flagged, not fixed here — see suite report.)'
    );
  });
});
