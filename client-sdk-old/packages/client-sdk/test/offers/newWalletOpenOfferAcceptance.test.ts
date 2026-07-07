import { describe, it, expect, vi } from 'vitest';
import type { IpfsProvider, RpcProvider } from '@membership-card-protocol/verifier';
import { createCardVerifier } from '../../src/verification/CardVerifier.js';
import { assembleAndSignOpenOffer } from '../../src/offers/openOffer.js';
import { acceptOpenOfferForNewWallet } from '../../src/offers/newWalletOpenOfferAcceptance.js';
import { decryptKeyring } from '../../src/wallet/keyring.js';
import { deriveDecryptionKey, passkeyOutputFromPrf } from '../../src/wallet/kdf.js';
import { mlDsa44GenerateKeypair, mlDsa44Sign, mlDsa44Verify } from '../../src/crypto/mldsa.js';
import { canonicalize } from '../../src/crypto/canonicalize.js';
import { keccak256 } from '../../src/crypto/hashes.js';
import { bytesToBase64Url, base64UrlToBytes } from '../../src/util/base64url.js';
import type { WalletAppCardIdentity, RegisterSubCardFn, SignedSubCardDocument } from '../../src/wallet/deviceSubCard.js';
import type { NotificationChannels } from '../../src/wallet/backupRegistration.js';
import type { PasskeyProvider } from '../../src/providers/PasskeyProvider.js';
import type { StorageProvider } from '../../src/providers/StorageProvider.js';
import type { SecureKeyProvider } from '../../src/providers/SecureKeyProvider.js';
import type {
  ObliviousProtocolTransport,
  ObliviousDestination,
  RequestOptions,
  ObliviousResponse,
} from '../../src/providers/ObliviousProtocolTransport.js';

function jsonResponse(status: number, body: unknown): ObliviousResponse {
  return { status, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
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

function makeFakeSecureKeyProvider(): SecureKeyProvider & { keys: Map<string, Uint8Array> } {
  const keys = new Map<string, Uint8Array>();
  const secretKeys = new Map<string, Uint8Array>();
  return {
    keys,
    generateKey: vi.fn(async (keyId: string) => {
      const keypair = mlDsa44GenerateKeypair();
      keys.set(keyId, keypair.publicKey);
      secretKeys.set(keyId, keypair.secretKey);
      return keypair.publicKey;
    }),
    sign: vi.fn(async (keyId: string, message: Uint8Array) => {
      const secretKey = secretKeys.get(keyId);
      if (!secretKey) throw new Error('no key');
      return mlDsa44Sign(secretKey, message);
    }),
    getPublicKey: vi.fn(async (keyId: string) => keys.get(keyId)),
    delete: vi.fn(),
  };
}

function makeFakeWalletAppCard(): WalletAppCardIdentity {
  const keypair = mlDsa44GenerateKeypair();
  return {
    cardPointer: 'wallet-app-card-pointer',
    publicKey: keypair.publicKey,
    sign: (message: Uint8Array) => mlDsa44Sign(keypair.secretKey, message),
  };
}

function makeFakeRegisterSubCard(): RegisterSubCardFn {
  return vi.fn(async (_doc: SignedSubCardDocument) => ({ registered: true }));
}

function makeFakePasskeyProvider(attestationObject: Uint8Array, credentialId: Uint8Array): PasskeyProvider {
  let registerCallCount = 0;
  return {
    register: vi.fn(async () => {
      registerCallCount += 1;
      if (registerCallCount === 1) {
        return { credentialId, attestationObject, clientDataJSON: new TextEncoder().encode('x'), prfOutput: attestationObject };
      }
      return {
        credentialId: new TextEncoder().encode(`synced-credential-${registerCallCount}`),
        attestationObject: new TextEncoder().encode(`synced-attestation-${registerCallCount}`),
        clientDataJSON: new TextEncoder().encode('x'),
        prfOutput: new TextEncoder().encode('synced-prf-output'),
      };
    }),
    assert: vi.fn(async () => ({
      credentialId,
      authenticatorData: new TextEncoder().encode('x'),
      clientDataJSON: new TextEncoder().encode('x'),
      signature: new TextEncoder().encode('x'),
      prfOutput: new TextEncoder().encode('synced-prf-output'),
    })),
  };
}

const NOTIFICATION_CHANNELS: NotificationChannels = { email: 'holder@example.com' };
const CAPABILITIES = ['auth_response'];
const POLICY_ADDRESS = 'cc'.repeat(32);
const PRESS_CARD = 'dd'.repeat(32);
const PRESS_BASE_URL = 'https://press.example';

const fakeIpfs: IpfsProvider = {
  fetch: async () => {
    throw new Error('not used — fetchAnnotations is false');
  },
};

function makeHappyPathRpc(issuerAddress: string): RpcProvider {
  return {
    getCardEntry: async (address) =>
      address === issuerAddress
        ? { log_head_cid: 'cid', policy_address: POLICY_ADDRESS, last_press_address: PRESS_CARD, forward_to: null, exists: true }
        : null,
    isPolicyAuthorizer: async (address) => address === issuerAddress,
    getPressAuthorization: async (policyAddress, pressAddress) =>
      policyAddress === POLICY_ADDRESS && pressAddress === PRESS_CARD
        ? { press_public_key: 'x', mldsa44_key_hash: 'y', active: true, authorized_at: '2026-01-01T00:00:00.000Z', revoked_at: null }
        : null,
    getSubCardEntry: async () => null,
    getLogEntries: async () => [],
    getEasAnnotations: async () => [],
  };
}

/** Combined stub wallet-service + press transport, matching how a single ObliviousProtocolTransport instance handles both destination kinds. */
function makeCombinedTransport() {
  const state = {
    accounts: new Map<string, { keyringId: string; serviceSecret: Uint8Array }>(),
    keyringBlobsById: new Map<string, string>(),
    backupRegistrations: 0,
    openOfferClaims: [] as Array<{ baseUrl: string; body: Record<string, unknown> }>,
    challengeCounter: 0,
  };
  const nextChallenge = () => {
    state.challengeCounter += 1;
    return bytesToBase64Url(new TextEncoder().encode(`challenge-${state.challengeCounter}`));
  };

  const transport: ObliviousProtocolTransport = {
    request: vi.fn(async (destination: ObliviousDestination, requestOptions: RequestOptions) => {
      const { method, path } = requestOptions;

      if (destination.kind === 'press') {
        if (method === 'POST' && path === '/open-offer/claim') {
          const body = readJsonBody(requestOptions);
          state.openOfferClaims.push({ baseUrl: destination.baseUrl, body });
          return jsonResponse(200, {
            card_cid: 'card-cid-123',
            scip: {
              card_cid: 'card-cid-123',
              policy_log_entry_index: 1,
              policy_log_root_at_inclusion: 'policy-log-root-cid',
              issued_at: new Date().toISOString(),
              press_signature: { public_key: 'press-pubkey', signature: 'press-sig' },
            },
          });
        }
        throw new Error(`stub press: unhandled ${method} ${path}`);
      }

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
        const newBlob = body.new_encrypted_keyring_blob as string;
        const newKeyringId = keccak256(base64UrlToBytes(newBlob));
        const rotate = body.rotate_service_secret !== false;
        const existing = state.accounts.get(cardHash);
        const serviceSecret = rotate ? crypto.getRandomValues(new Uint8Array(32)) : existing!.serviceSecret;
        state.keyringBlobsById.set(newKeyringId, newBlob);
        state.accounts.set(cardHash, { keyringId: newKeyringId, serviceSecret });
        return jsonResponse(200, { service_secret: bytesToBase64Url(serviceSecret), keyring_id: newKeyringId });
      }
      const backupsMatch = path.match(/^\/accounts\/([^/]+)\/backups$/);
      if (method === 'POST' && backupsMatch) {
        state.backupRegistrations += 1;
        return jsonResponse(200, { backup_id: `backup-${state.backupRegistrations}` });
      }

      throw new Error(`stub wallet service: unhandled ${method} ${path}`);
    }),
  };

  return { transport, state };
}

describe('acceptOpenOfferForNewWallet', () => {
  it('end-to-end: reviews the offer, sets up a new wallet, countersigns, and submits the claim to the press via ObliviousProtocolTransport', async () => {
    const issuer = mlDsa44GenerateKeypair();
    const issuerAddress = keccak256(issuer.publicKey);
    const issuerSignerProvider: SecureKeyProvider = {
      generateKey: vi.fn(async () => issuer.publicKey),
      sign: vi.fn(async (_id: string, message: Uint8Array) => mlDsa44Sign(issuer.secretKey, message)),
      getPublicKey: vi.fn(async () => issuer.publicKey),
      delete: vi.fn(),
    };

    const { offer } = await assembleAndSignOpenOffer({
      secureKeyProvider: issuerSignerProvider,
      issuerSigningKeyId: 'issuer-key',
      policyId: 'policy-cid',
      pressCard: PRESS_CARD,
      issuerCard: issuerAddress,
      issuerPubkey: issuer.publicKey,
      maxAcceptances: 100,
      proposedFields: { tier: 'silver' },
    });

    const rpc = makeHappyPathRpc(issuerAddress);
    const cardVerifier = createCardVerifier({ rpc, ipfs: fakeIpfs, appCertificationRoot: issuerAddress, trustedRoots: [issuerAddress] });

    const { transport, state } = makeCombinedTransport();
    const attestationObject = new TextEncoder().encode('device-attestation');
    const credentialId = new TextEncoder().encode('device-credential');
    const passkeyProvider = makeFakePasskeyProvider(attestationObject, credentialId);
    const storageProvider = makeFakeStorageProvider();
    const secureKeyProvider = makeFakeSecureKeyProvider();
    const walletAppCard = makeFakeWalletAppCard();
    const registerSubCard = makeFakeRegisterSubCard();

    const result = await acceptOpenOfferForNewWallet({
      offer,
      chainVerification: { cardVerifier, rpc, policyAddress: POLICY_ADDRESS },
      pressBaseUrl: PRESS_BASE_URL,
      passkeyProvider,
      storageProvider,
      transport,
      secureKeyProvider,
      walletAppCard,
      registerSubCard,
      capabilities: CAPABILITIES,
      notificationChannels: NOTIFICATION_CHANNELS,
    });

    expect(result.approved).toBe(true);
    if (!result.approved) throw new Error('unreachable');

    // Claim was submitted to the offer's press, via the oblivious transport
    // (never a raw fetch — the only network primitive this function has
    // access to is `transport`).
    expect(state.openOfferClaims).toHaveLength(1);
    expect(state.openOfferClaims[0]!.baseUrl).toBe(PRESS_BASE_URL);
    const claimBody = state.openOfferClaims[0]!.body;
    expect((claimBody.claim_payload as { offer: unknown }).offer).toEqual(offer);
    expect(result.cardCid).toBe('card-cid-123');
    expect(result.scip.card_cid).toBe('card-cid-123');

    // The claim's recipient_signature verifies against the returned new card key.
    const recipientSig = base64UrlToBytes(claimBody.recipient_signature as string);
    expect(
      mlDsa44Verify(result.newCardPublicKey, canonicalize(claimBody.claim_payload), recipientSig)
    ).toBe(true);

    // The keyring now holds both the wallet's master key and the new card's key.
    const account = state.accounts.get(result.walletSetup.cardHash)!;
    const devicePasskeyOutput = passkeyOutputFromPrf(attestationObject);
    const decryptionKey = deriveDecryptionKey(devicePasskeyOutput, account.serviceSecret);
    const storedBlob = storageProvider.store.get('keyring')!;
    const entries = decryptKeyring(storedBlob, decryptionKey);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.cardAddress).toBe(result.walletSetup.cardHash);
    expect(entries[1]!.cardAddress).toBe(keccak256(result.newCardPublicKey));

    // Wallet setup itself completed normally (sub-card, backups, etc.).
    expect(result.walletSetup.subCardRegistered).toBe(true);
    expect(result.walletSetup.syncedPasskeyBackupId).toBeTruthy();
  });

  it('rejects the offer before any wallet setup or network side effect when verification fails', async () => {
    const issuer = mlDsa44GenerateKeypair();
    const wrongIssuer = mlDsa44GenerateKeypair();
    const issuerAddress = keccak256(issuer.publicKey);

    const issuerSignerProvider: SecureKeyProvider = {
      generateKey: vi.fn(async () => issuer.publicKey),
      sign: vi.fn(async (_id: string, message: Uint8Array) => mlDsa44Sign(issuer.secretKey, message)),
      getPublicKey: vi.fn(async () => issuer.publicKey),
      delete: vi.fn(),
    };

    const { offer } = await assembleAndSignOpenOffer({
      secureKeyProvider: issuerSignerProvider,
      issuerSigningKeyId: 'issuer-key',
      policyId: 'policy-cid',
      pressCard: PRESS_CARD,
      // issuer_card deliberately does not match issuer_pubkey's derived address.
      issuerCard: keccak256(wrongIssuer.publicKey),
      issuerPubkey: issuer.publicKey,
      maxAcceptances: 100,
      proposedFields: {},
    });

    const rpc = makeHappyPathRpc(issuerAddress);
    const cardVerifier = createCardVerifier({ rpc, ipfs: fakeIpfs, appCertificationRoot: issuerAddress, trustedRoots: [issuerAddress] });
    const { transport, state } = makeCombinedTransport();

    const result = await acceptOpenOfferForNewWallet({
      offer,
      chainVerification: { cardVerifier, rpc, policyAddress: POLICY_ADDRESS },
      pressBaseUrl: PRESS_BASE_URL,
      passkeyProvider: makeFakePasskeyProvider(new TextEncoder().encode('x'), new TextEncoder().encode('y')),
      storageProvider: makeFakeStorageProvider(),
      transport,
      secureKeyProvider: makeFakeSecureKeyProvider(),
      walletAppCard: makeFakeWalletAppCard(),
      registerSubCard: makeFakeRegisterSubCard(),
      capabilities: CAPABILITIES,
      notificationChannels: NOTIFICATION_CHANNELS,
    });

    expect(result.approved).toBe(false);
    if (result.approved) throw new Error('unreachable');
    expect(result.code).toBe('issuer_binding_mismatch');

    // No wallet-service or press call was ever made.
    expect(state.accounts.size).toBe(0);
    expect(state.openOfferClaims).toHaveLength(0);
  });
});
